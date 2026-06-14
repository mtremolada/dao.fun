/**
 * Shared bankrun harness for the gate integration suites: loads the REAL
 * mainnet program binaries from tests/fixtures (dumped by
 * scripts/dump-mainnet-programs.ts), stands up production-parameter DAOs
 * with the SAME sdk builders the launch flow uses, and drives proposals
 * through the production propose builder (buildProposeIxs).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import BN from "bn.js";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  GovernanceAccountParser,
  Proposal,
  ProposalState,
  ProposalTransaction,
  Vote,
  VoteChoice,
  VoteKind,
  createInstructionData,
  getProposalTransactionAddress,
  getTokenOwnerRecordAddress,
  withCastVote,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import {
  Clock,
  start,
  type AddedAccount,
  type AddedProgram,
  type ProgramTestContext,
} from "solana-bankrun";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
} from "../../packages/sdk/src/constants";
import { resolveGovernanceParams } from "../../packages/sdk/src/matrix";
import { buildCreateDaoIxs } from "../../packages/sdk/src/governance";
import { buildCreateTreasuryIx } from "../../packages/sdk/src/treasury";
import { buildProposeIxs } from "../../packages/sdk/src/proposal";
import { deriveGovernanceChainFromMint } from "../../packages/sdk/src/pda";
import type {
  GovernanceMode,
  GovernanceParams,
} from "../../packages/sdk/src/types";
import { hashWrappedInstructionSet } from "../../packages/backend/src/chain-reader";

const FIXTURES = resolve(__dirname, "..", "fixtures");
process.env.SBF_OUT_DIR = FIXTURES;

// Program binaries are committed gzipped (zero-padded programdata
// compresses ~10x); inflate once so bankrun can load the .so files.
for (const f of readdirSync(FIXTURES)) {
  if (f.endsWith(".so.gz")) {
    const so = join(FIXTURES, f.slice(0, -".gz".length));
    if (!existsSync(so)) {
      writeFileSync(so, gunzipSync(readFileSync(join(FIXTURES, f))));
    }
  }
}

export const PROGRAM_VERSION = 3;
export const SUPPLY = 200_000_000_000n; // 200k tokens at 6 decimals, like the mainnet run
export const BASE_VOTING_TIME_S = 3 * 86400; // production default (D-012) — we warp
export const MICRO_HOLDUP_S = 72 * 3600;
export const VAULT_FUND = 890_880;
// D-016: the native treasury pays Squads rent at execution time
// (VaultTransactionCreate 2,429,040 + ProposalCreate 2,046,240) on top of
// its own 890,880 floor.
export const TREASURY_PREFUND = 6_000_000;
export const TEST_TIMEOUT = 300_000;

export const squadsConfig = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/squads-program-config.json"), "utf8"),
) as { address: string; owner: string; lamports: number; treasury: string; dataBase64: string };

// ---------- bankrun harness ----------

export async function startCtx(
  extraPrograms: AddedProgram[] = [],
  extraAccounts: AddedAccount[] = [],
): Promise<ProgramTestContext> {
  return start(
    [
      { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
      { name: "squads_v4", programId: SQUADS_V4_PROGRAM_ID },
      ...extraPrograms,
    ],
    [
      ...extraAccounts,
      {
        address: new PublicKey(squadsConfig.address),
        info: {
          lamports: squadsConfig.lamports,
          data: Buffer.from(squadsConfig.dataBase64, "base64"),
          owner: new PublicKey(squadsConfig.owner),
          executable: false,
        },
      },
    ],
  );
}

/**
 * Context with the pump stack loaded on top of governance + Squads, plus
 * the live pump/PumpFees/mayhem state accounts from the fixtures dump.
 */
export function startPumpCtx(): Promise<ProgramTestContext> {
  const pumpAccounts = (
    JSON.parse(readFileSync(join(FIXTURES, "pump-accounts.json"), "utf8")) as {
      address: string;
      owner: string;
      lamports: number;
      dataBase64: string;
    }[]
  ).map((a) => ({
    address: new PublicKey(a.address),
    info: {
      lamports: a.lamports,
      data: Buffer.from(a.dataBase64, "base64"),
      owner: new PublicKey(a.owner),
      executable: false,
    },
  }));
  return startCtx(
    [
      { name: "pump", programId: PUMP_PROGRAM_ID },
      { name: "pump_fees", programId: PUMP_FEES_PROGRAM_ID },
      { name: "pump_amm", programId: PUMP_AMM_PROGRAM_ID },
      { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
    ],
    pumpAccounts,
  );
}

export async function send(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer?: Keypair,
): Promise<void> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const payer = feePayer ?? ctx.payer;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  await ctx.banksClient.processTransaction(tx);
}

/**
 * Send one instruction as a v0 transaction with a throwaway address lookup
 * table compressing its static keys — the packing for inserts whose DATA
 * (e.g. an account-heavy vaultTransactionExecute) leaves no room for the
 * outer account list in a legacy tx. Production senders need the same
 * fallback (recorded with GATE 0c).
 */
export async function sendWithAlt(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  payer: Keypair,
): Promise<void> {
  // recentSlot must be IN SlotHashes; the current slot itself never is
  // (at genesis the sysvar holds only slot 0 while getSlot() is 1).
  const slot = (await ctx.banksClient.getSlot()) - 1n;
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  // Program ids must stay static in v0 messages; everything else can load
  // from the table.
  const addresses = [
    ...new Map(
      ixs
        .flatMap((ix) => ix.keys)
        .filter((k) => !k.isSigner) // signers must be static
        .map((k) => [k.pubkey.toBase58(), k.pubkey]),
    ).values(),
  ];
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: table,
    authority: payer.publicKey,
    payer: payer.publicKey,
    addresses,
  });
  await send(ctx, [createIx, extendIx], [payer], payer);

  // table entries activate in the NEXT slot
  ctx.warpToSlot((await ctx.banksClient.getSlot()) + 1n);
  const info = await ctx.banksClient.getAccount(table);
  const lookup = new AddressLookupTableAccount({
    key: table,
    state: AddressLookupTableAccount.deserialize(Buffer.from(info!.data)),
  });

  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([lookup]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  await ctx.banksClient.processTransaction(vtx);
}


/**
 * D-009: prefund every missing writable account an instruction set touches
 * to the rent floor — trades pay sub-floor fee crumbs to fee recipients,
 * and the runtime rejects transactions that leave accounts below the
 * floor. Program-init'd accounts tolerate pre-funded addresses.
 */
export async function prefundMissingWritables(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
): Promise<void> {
  const RENT_FLOOR = 890_880;
  const targets = new Map<string, PublicKey>();
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isWritable && !k.isSigner) targets.set(k.pubkey.toBase58(), k.pubkey);
    }
  }
  const transfers: TransactionInstruction[] = [];
  for (const target of targets.values()) {
    if (!(await ctx.banksClient.getAccount(target))) {
      transfers.push(
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: target,
          lamports: RENT_FLOOR,
        }),
      );
    }
  }
  if (transfers.length > 0) await send(ctx, transfers, []);
}

/**
 * Like send(), but returns the compute units the transaction consumed
 * (Stage 2 CU-budget suite, spec Section 8: "measured per executed
 * governance tx; fail test if within 15% of limit").
 */
export async function sendMeasured(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer?: Keypair,
): Promise<bigint> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const payer = feePayer ?? ctx.payer;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const result = await ctx.banksClient.tryProcessTransaction(tx);
  if (result.result !== null) {
    throw new Error(
      [result.result, ...(result.meta?.logMessages ?? [])].join("\n"),
    );
  }
  return result.meta?.computeUnitsConsumed ?? 0n;
}

/** Sends expecting failure; returns error + program logs for assertions. */
export async function sendExpectFail(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ...signers.filter((s) => !s.publicKey.equals(ctx.payer.publicKey)));
  const result = await ctx.banksClient.tryProcessTransaction(tx);
  if (result.result === null) {
    throw new Error("transaction unexpectedly succeeded");
  }
  return [result.result, ...(result.meta?.logMessages ?? [])].join("\n");
}

export async function warpSeconds(ctx: ProgramTestContext, seconds: number) {
  const clock = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp + BigInt(seconds),
    ),
  );
}

export async function balance(ctx: ProgramTestContext, addr: PublicKey): Promise<number> {
  const acc = await ctx.banksClient.getAccount(addr);
  return acc ? Number(acc.lamports) : 0;
}

export async function readGov<T>(
  ctx: ProgramTestContext,
  addr: PublicKey,
  type: new (...args: never[]) => T,
): Promise<T> {
  const info = await ctx.banksClient.getAccount(addr);
  if (!info) throw new Error(`account ${addr.toBase58()} not found`);
  return GovernanceAccountParser(type as never)(addr, {
    executable: info.executable,
    owner: info.owner,
    lamports: Number(info.lamports),
    data: Buffer.from(info.data),
  }).account as T;
}

// ---------- DAO setup (same builders as the launch flow) ----------

export interface Dao {
  mint: PublicKey;
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  params: GovernanceParams;
  voter: Keypair;
  voterTor: PublicKey;
  councilMint: PublicKey | null;
  councilMember: Keypair;
  councilTor: PublicKey | null;
  /** All human council members (council: 1; guarded: 2). [0] == councilMember. */
  councilMembers: Keypair[];
  councilTors: PublicKey[];
  /** Guarded only: the gate PDA (realm authority + creation seat). */
  gate: PublicKey | null;
}

export async function mintRent(ctx: ProgramTestContext): Promise<bigint> {
  const rent = await ctx.banksClient.getRent();
  return rent.minimumBalance(BigInt(MINT_SIZE));
}

export async function createDao(
  ctx: ProgramTestContext,
  mode: GovernanceMode,
): Promise<Dao> {
  const payer = ctx.payer;
  const voter = Keypair.generate();
  // Guarded needs >1 human so the veto-vs-creation split is exercised.
  const councilMembers =
    mode === "guarded"
      ? [Keypair.generate(), Keypair.generate()]
      : [Keypair.generate()];
  const councilMember = councilMembers[0]!;
  const hasCouncil = mode === "council" || mode === "guarded";
  const mint = Keypair.generate();
  const councilMintKp = Keypair.generate();
  const createKey = Keypair.generate();
  const rentLamports = Number(await mintRent(ctx));

  // Community mint: full supply to the voter, then no mint authority
  // (mirrors a pump launch's null authority, INV-5).
  const voterAta = getAssociatedTokenAddressSync(mint.publicKey, voter.publicKey);
  await send(
    ctx,
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: voter.publicKey,
        lamports: 1_000_000_000,
      }),
      ...councilMembers.map((m) =>
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: m.publicKey,
          lamports: 1_000_000_000,
        }),
      ),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: rentLamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        voterAta,
        voter.publicKey,
        mint.publicKey,
      ),
      createMintToInstruction(mint.publicKey, voterAta, payer.publicKey, SUPPLY),
      createSetAuthorityInstruction(
        mint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
    ],
    [mint],
  );

  const params = resolveGovernanceParams({
    mode,
    tier: "micro",
    communitySupply: SUPPLY,
  });

  // Treasury first, against the advance-derived native treasury (the same
  // ordering the launch orchestrator uses).
  const chain = deriveGovernanceChainFromMint(mint.publicKey);
  const treasury = buildCreateTreasuryIx({
    payer: payer.publicKey,
    predictedNativeTreasury: chain.nativeTreasury,
    createKey: createKey.publicKey,
    programConfigTreasury: new PublicKey(squadsConfig.treasury),
  });
  await send(ctx, [treasury.ix], [createKey]);

  // D-016: the real program accepted rentCollector == native treasury, so
  // execution rent flows back to the DAO when Squads accounts close.
  const msInfo = await ctx.banksClient.getAccount(treasury.multisigPda);
  const [msState] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msInfo!.lamports),
    data: Buffer.from(msInfo!.data),
  });
  expect(msState.rentCollector?.toBase58()).toBe(chain.nativeTreasury.toBase58());

  const dao = await buildCreateDaoIxs({
    mint: mint.publicKey,
    payer: payer.publicKey,
    mode,
    params,
    ...(hasCouncil
      ? {
          council: {
            mint: councilMintKp.publicKey,
            members: councilMembers.map((m) => m.publicKey),
            // Guarded: nominal HUMAN percent (the builder adjusts for the
            // gate seat's council share) — 100 == unanimous humans.
            vetoThresholdPercent: mode === "guarded" ? 100 : 50,
            mintRentLamports: BigInt(rentLamports),
          },
        }
      : {}),
    baseVotingTimeSeconds: BASE_VOTING_TIME_S,
    communityVoterWeightAddin: null, // no-addin realm (D-013 MVP fallback)
  });
  expect(dao.realm.toBase58()).toBe(chain.realm.toBase58());
  expect(dao.nativeTreasury.toBase58()).toBe(chain.nativeTreasury.toBase58());

  // Execution order is the builder's contract: council mint first (the
  // realm registers it), then realm, then governance, then (guarded) the
  // gate ceremony.
  if (dao.groups.council.length > 0) {
    await send(ctx, dao.groups.council, [councilMintKp]);
  }
  await send(ctx, dao.groups.realmSetup, []);
  await send(ctx, dao.groups.governanceSetup, []);
  if (dao.groups.gateSetup.length > 0) {
    await send(ctx, dao.groups.gateSetup, []);
  }

  // Voting power: deposit the full supply (no-addin: deposit == weight).
  // Guarded: keep the gate's requester threshold UNdeposited — the gate
  // checks a token-account balance, and the voter doubles as requester.
  const depositAmount =
    mode === "guarded" ? SUPPLY - params.proposalThresholdTokens : SUPPLY;
  const depositIxs: TransactionInstruction[] = [];
  await withDepositGoverningTokens(
    depositIxs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    voterAta,
    mint.publicKey,
    voter.publicKey,
    voter.publicKey,
    payer.publicKey,
    new BN(depositAmount.toString()),
  );
  await send(ctx, depositIxs, [voter]);
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    mint.publicKey,
    voter.publicKey,
  );

  // Council membership: deposit the 1 council token per member the
  // ceremony minted (Membership type — never withdrawable).
  const councilTors: PublicKey[] = [];
  if (hasCouncil) {
    for (const member of councilMembers) {
      const memberAta = getAssociatedTokenAddressSync(
        councilMintKp.publicKey,
        member.publicKey,
        true,
      );
      const ixs: TransactionInstruction[] = [];
      await withDepositGoverningTokens(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        memberAta,
        councilMintKp.publicKey,
        member.publicKey,
        member.publicKey,
        payer.publicKey,
        new BN(1),
      );
      await send(ctx, ixs, [member]);
      councilTors.push(
        await getTokenOwnerRecordAddress(
          SPL_GOVERNANCE_PROGRAM_ID,
          dao.realm,
          councilMintKp.publicKey,
          member.publicKey,
        ),
      );
    }
  }
  const councilTor = councilTors[0] ?? null;

  // Fund: vault gets the lamports the proposals will sweep; treasury gets
  // its floor + Squads execution rent (D-016).
  await send(
    ctx,
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: treasury.vaultPda,
        lamports: VAULT_FUND,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: dao.nativeTreasury,
        lamports: TREASURY_PREFUND,
      }),
    ],
    [],
  );

  return {
    mint: mint.publicKey,
    realm: dao.realm,
    governance: dao.governance,
    nativeTreasury: dao.nativeTreasury,
    multisigPda: treasury.multisigPda,
    vaultPda: treasury.vaultPda,
    params,
    voter,
    voterTor,
    councilMint: hasCouncil ? councilMintKp.publicKey : null,
    councilMember,
    councilTor,
    councilMembers,
    councilTors,
    gate: dao.gate,
  };
}

// ---------- proposal lifecycle ----------

export interface MadeProposal {
  proposal: PublicKey;
  wrapped: TransactionInstruction[];
  ptAddrs: PublicKey[];
  innerHash: string;
  recipient: PublicKey;
}

export async function proposeSweep(
  ctx: ProgramTestContext,
  dao: Dao,
  proposalIndex: number,
): Promise<MadeProposal> {
  const recipient = Keypair.generate().publicKey;
  const inner = [
    SystemProgram.transfer({
      fromPubkey: dao.vaultPda,
      toPubkey: recipient,
      lamports: VAULT_FUND,
    }),
  ];
  const made = await proposeInner(ctx, dao, proposalIndex, inner, "sweep vault");
  return { ...made, recipient };
}

/** Propose an arbitrary inner set through the production builder. */
export async function proposeInner(
  ctx: ProgramTestContext,
  dao: Dao,
  proposalIndex: number,
  inner: TransactionInstruction[],
  label: string,
  directIxs?: TransactionInstruction[],
): Promise<MadeProposal> {
  const recipient = PublicKey.default; // unused for non-sweep proposals

  const msAccount = await ctx.banksClient.getAccount(dao.multisigPda);
  const [ms] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msAccount!.lamports),
    data: Buffer.from(msAccount!.data),
  });
  const txIndex = BigInt(ms.transactionIndex.toString()) + 1n;

  // The production propose builder (D-017: descriptionLink == hash;
  // per-transaction hold-up; ExecutionAdapter wrapping).
  const made = await buildProposeIxs({
    realm: dao.realm,
    governance: dao.governance,
    governingTokenMint: dao.mint,
    tokenOwnerRecord: dao.voterTor,
    governanceAuthority: dao.voter.publicKey,
    // payer == proposer keeps inserts single-signer (size headroom for
    // account-heavy execute inserts)
    payer: dao.voter.publicKey,
    proposalIndex,
    name: `${label} #${proposalIndex}`,
    innerIxs: inner,
    ...(directIxs ? { directIxs } : {}),
    wrapCtx: {
      multisigPda: dao.multisigPda,
      vaultIndex: 0,
      transactionIndex: txIndex,
      member: dao.nativeTreasury,
    },
    holdUpSeconds: dao.params.holdUpSeconds,
  });

  await send(ctx, made.groups.create, [dao.voter], dao.voter);
  const ptAddrs: PublicKey[] = [];
  for (const [i, group] of made.groups.inserts.entries()) {
    try {
      await send(ctx, group, [dao.voter], dao.voter);
    } catch (e) {
      if (!/too large/i.test((e as Error).message) || group.length !== 1) throw e;
      // account-heavy execute insert: pack as v0 + lookup table
      await sendWithAlt(ctx, group, dao.voter);
    }
    ptAddrs.push(
      await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        made.proposal,
        0,
        i,
      ),
    );
  }
  await send(ctx, made.groups.signOff, [dao.voter], dao.voter);

  // D-017 verified on chain state: the proposal's descriptionLink IS the
  // artifact hash.
  const onChain = await readGov(ctx, made.proposal, Proposal);
  expect(onChain.descriptionLink).toBe(made.innerInstructionSetHash);

  return {
    proposal: made.proposal,
    wrapped: made.wrapped,
    ptAddrs,
    innerHash: made.innerInstructionSetHash,
    recipient,
  };
}

export async function castCommunityYes(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
  /** Gate-authored proposals are owned by the gate's council TOR. */
  proposalOwnerTor?: PublicKey,
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    proposalOwnerTor ?? dao.voterTor,
    dao.voterTor,
    dao.voter.publicKey,
    dao.mint,
    new Vote({
      voteType: VoteKind.Approve,
      approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
      deny: undefined,
      veto: undefined,
    }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [dao.voter]);
}

export async function castCouncilVeto(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
  memberIndex = 0,
  /** Gate-authored proposals are owned by the gate's council TOR. */
  proposalOwnerTor?: PublicKey,
) {
  const member = dao.councilMembers[memberIndex]!;
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    proposalOwnerTor ?? dao.voterTor, // proposal owner's record
    dao.councilTors[memberIndex]!,
    member.publicKey,
    dao.councilMint!, // the VETOING token is the council mint (D-011)
    new Vote({
      voteType: VoteKind.Veto,
      approveChoices: undefined,
      deny: undefined,
      veto: true,
    }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [member]);
}

export async function finalizeAfterVotingWindow(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
  /** Gate-authored proposals are owned by the gate's council TOR. */
  proposalOwnerTor?: PublicKey,
): Promise<ProposalState> {
  await warpSeconds(ctx, BASE_VOTING_TIME_S + 10);
  const ixs: TransactionInstruction[] = [];
  await withFinalizeVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    proposalOwnerTor ?? dao.voterTor,
    dao.mint,
  );
  await send(ctx, ixs, []);
  return (await readGov(ctx, proposal, Proposal)).state;
}

export async function executeIxsFor(
  dao: Dao,
  made: MadeProposal,
  i: number,
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  await withExecuteTransaction(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.governance,
    made.proposal,
    made.ptAddrs[i]!,
    [createInstructionData(made.wrapped[i]!)],
  );
  return ixs;
}

export async function executeAll(ctx: ProgramTestContext, dao: Dao, made: MadeProposal) {
  for (let i = 0; i < made.ptAddrs.length; i++) {
    // Production tx hygiene: governance execute -> Squads execute -> inner
    // CPIs stack beyond the 200k default (the mainnet runs sent 400k too).
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const ixs = [cu, ...(await executeIxsFor(dao, made, i))];
    try {
      await send(ctx, ixs, []);
    } catch (e) {
      if (!/too large/i.test((e as Error).message)) throw e;
      // account-heavy direct-leg execute (D-022): v0 + lookup table
      await sendWithAlt(ctx, ixs, ctx.payer);
    }
  }
}

/** INV-9: re-read the ProposalTransactions and hash what will execute. */
export async function chainHashOf(
  ctx: ProgramTestContext,
  made: MadeProposal,
): Promise<string | null> {
  const onChain: TransactionInstruction[] = [];
  for (const addr of made.ptAddrs) {
    const pt = await readGov(ctx, addr, ProposalTransaction);
    for (const d of pt.getAllInstructions()) {
      onChain.push(
        new TransactionInstruction({
          programId: d.programId,
          keys: d.accounts.map((a) => ({
            pubkey: a.pubkey,
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(d.data),
        }),
      );
    }
  }
  return hashWrappedInstructionSet(onChain);
}
