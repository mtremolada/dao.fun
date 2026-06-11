/**
 * GATE 1 mode matrix — council + cypherpunk legs (spec Section 13.8).
 *
 * Runs the REAL mainnet program binaries (SPL Governance + Squads v4,
 * dumped by scripts/dump-mainnet-programs.ts) in solana-bankrun, driving
 * the SAME sdk builders the mainnet sovereign run used. Clock control
 * makes the assertions a live cluster cannot give us:
 *
 * - council leg: a council veto moves the proposal to Vetoed and execution
 *   is refused (INV-4); a NON-vetoed proposal on the same DAO executes —
 *   but only after the 72h micro-tier hold-up has elapsed (INV-3).
 * - cypherpunk leg: the realm is built with NO council accounts
 *   (structural, spec 12.2), the 72h hold-up gates execution (INV-3),
 *   and the full Squads custody chain moves the vault's lamports.
 * - both legs: the instruction-set hash recomputed from the on-chain
 *   ProposalTransactions matches the published artifact hash (INV-9).
 *
 * Production params throughout (sovereign/micro deviation-free: 3-day
 * voting window included — we warp instead of shrinking it).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
  InstructionExecutionStatus,
  Proposal,
  ProposalState,
  ProposalTransaction,
  Realm,
  Vote,
  VoteChoice,
  VoteKind,
  VoteType,
  createInstructionData,
  getProposalTransactionAddress,
  getTokenOwnerRecordAddress,
  withCastVote,
  withCreateProposal,
  withCreateTokenOwnerRecord,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
  withInsertTransaction,
  withSignOffProposal,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import { Clock, start, type ProgramTestContext } from "solana-bankrun";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  LockupKind,
  buildCreateDepositEntryIx,
  buildCreateVoterIx,
  buildDepositIx,
  buildUpdateVoterWeightRecordIx,
} from "../packages/sdk/src/vsr";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import { buildCreateTreasuryIx } from "../packages/sdk/src/treasury";
import { deriveGovernanceChainFromMint } from "../packages/sdk/src/pda";
import { wrap } from "../packages/sdk/src/execution-adapter";
import type { GovernanceMode, GovernanceParams } from "../packages/sdk/src/types";
import { computeInstructionSetHash } from "../packages/backend/src/artifacts";
import { hashWrappedInstructionSet } from "../packages/backend/src/chain-reader";

process.env.SBF_OUT_DIR = resolve(__dirname, "fixtures");

const PROGRAM_VERSION = 3;
const SUPPLY = 200_000_000_000n; // 200k tokens at 6 decimals, like the mainnet run
const BASE_VOTING_TIME_S = 3 * 86400; // production default (D-012) — we warp
const MICRO_HOLDUP_S = 72 * 3600;
const VAULT_FUND = 890_880;
// D-016: the native treasury pays Squads rent at execution time
// (VaultTransactionCreate 2,429,040 + ProposalCreate 2,046,240) on top of
// its own 890,880 floor.
const TREASURY_PREFUND = 6_000_000;
const TEST_TIMEOUT = 300_000;

const squadsConfig = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures/squads-program-config.json"), "utf8"),
) as { address: string; owner: string; lamports: number; treasury: string; dataBase64: string };

// ---------- bankrun harness ----------

async function startCtx(): Promise<ProgramTestContext> {
  return start(
    [
      { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
      { name: "squads_v4", programId: SQUADS_V4_PROGRAM_ID },
    ],
    [
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

async function send(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<void> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ...signers.filter((s) => !s.publicKey.equals(ctx.payer.publicKey)));
  await ctx.banksClient.processTransaction(tx);
}

/** Sends expecting failure; returns error + program logs for assertions. */
async function sendExpectFail(
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

async function warpSeconds(ctx: ProgramTestContext, seconds: number) {
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

async function balance(ctx: ProgramTestContext, addr: PublicKey): Promise<number> {
  const acc = await ctx.banksClient.getAccount(addr);
  return acc ? Number(acc.lamports) : 0;
}

async function readGov<T>(
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

interface Dao {
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
}

async function mintRent(ctx: ProgramTestContext): Promise<bigint> {
  const rent = await ctx.banksClient.getRent();
  return rent.minimumBalance(BigInt(MINT_SIZE));
}

async function createDao(
  ctx: ProgramTestContext,
  mode: GovernanceMode,
): Promise<Dao> {
  const payer = ctx.payer;
  const voter = Keypair.generate();
  const councilMember = Keypair.generate();
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
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: councilMember.publicKey,
        lamports: 1_000_000_000,
      }),
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

  const dao = await buildCreateDaoIxs({
    mint: mint.publicKey,
    payer: payer.publicKey,
    mode,
    params,
    ...(mode === "council"
      ? {
          council: {
            mint: councilMintKp.publicKey,
            members: [councilMember.publicKey],
            vetoThresholdPercent: 50,
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
  // realm registers it), then realm, then governance.
  if (dao.groups.council.length > 0) {
    await send(ctx, dao.groups.council, [councilMintKp]);
  }
  await send(ctx, dao.groups.realmSetup, []);
  await send(ctx, dao.groups.governanceSetup, []);

  // Voting power: deposit the full supply (no-addin: deposit == weight).
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
    new BN(SUPPLY.toString()),
  );
  await send(ctx, depositIxs, [voter]);
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    mint.publicKey,
    voter.publicKey,
  );

  // Council membership: deposit the 1 council token the ceremony minted.
  let councilTor: PublicKey | null = null;
  if (mode === "council") {
    const memberAta = getAssociatedTokenAddressSync(
      councilMintKp.publicKey,
      councilMember.publicKey,
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
      councilMember.publicKey,
      councilMember.publicKey,
      payer.publicKey,
      new BN(1),
    );
    await send(ctx, ixs, [councilMember]);
    councilTor = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      dao.realm,
      councilMintKp.publicKey,
      councilMember.publicKey,
    );
  }

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
    councilMint: mode === "council" ? councilMintKp.publicKey : null,
    councilMember,
    councilTor,
  };
}

// ---------- proposal lifecycle ----------

interface MadeProposal {
  proposal: PublicKey;
  wrapped: TransactionInstruction[];
  ptAddrs: PublicKey[];
  innerHash: string;
  recipient: PublicKey;
}

async function proposeSweep(
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
  const innerHash = computeInstructionSetHash(inner);

  const msAccount = await ctx.banksClient.getAccount(dao.multisigPda);
  const [ms] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msAccount!.lamports),
    data: Buffer.from(msAccount!.data),
  });
  const txIndex = BigInt(ms.transactionIndex.toString()) + 1n;
  const wrapped = wrap(inner, {
    multisigPda: dao.multisigPda,
    vaultIndex: 0,
    transactionIndex: txIndex,
    member: dao.nativeTreasury,
  });

  const createIxs: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    createIxs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    dao.voterTor,
    `sweep vault #${proposalIndex}`,
    innerHash, // D-017: descriptionLink carries the artifact hash
    dao.mint,
    dao.voter.publicKey,
    proposalIndex,
    VoteType.SINGLE_CHOICE,
    ["Approve"],
    true,
    ctx.payer.publicKey,
  );
  await send(ctx, createIxs, [dao.voter]);

  const ptAddrs: PublicKey[] = [];
  for (const [i, ix] of wrapped.entries()) {
    const ixs: TransactionInstruction[] = [];
    await withInsertTransaction(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.governance,
      proposal,
      dao.voterTor,
      dao.voter.publicKey,
      i,
      0,
      dao.params.holdUpSeconds, // tier hold-up on every transaction (INV-3)
      [createInstructionData(ix)],
      ctx.payer.publicKey,
    );
    await send(ctx, ixs, [dao.voter]);
    ptAddrs.push(
      await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        proposal,
        0,
        i,
      ),
    );
  }

  const signOffIxs: TransactionInstruction[] = [];
  withSignOffProposal(
    signOffIxs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voter.publicKey,
    undefined,
    dao.voterTor,
  );
  await send(ctx, signOffIxs, [dao.voter]);

  return { proposal, wrapped, ptAddrs, innerHash, recipient };
}

async function castCommunityYes(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voterTor,
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

async function castCouncilVeto(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voterTor, // proposal owner's record
    dao.councilTor!,
    dao.councilMember.publicKey,
    dao.councilMint!, // the VETOING token is the council mint (D-011)
    new Vote({
      voteType: VoteKind.Veto,
      approveChoices: undefined,
      deny: undefined,
      veto: true,
    }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [dao.councilMember]);
}

async function finalizeAfterVotingWindow(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
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
    dao.voterTor,
    dao.mint,
  );
  await send(ctx, ixs, []);
  return (await readGov(ctx, proposal, Proposal)).state;
}

async function executeIxsFor(
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

async function executeAll(ctx: ProgramTestContext, dao: Dao, made: MadeProposal) {
  for (let i = 0; i < made.ptAddrs.length; i++) {
    await send(ctx, await executeIxsFor(dao, made, i), []);
  }
}

/** INV-9: re-read the ProposalTransactions and hash what will execute. */
async function chainHashOf(
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

// ---------- the legs ----------

describe("GATE 1 council leg (real binaries, bankrun)", () => {
  it(
    "council veto moves the proposal to Vetoed and execution is refused (INV-4); a non-vetoed proposal executes only after the 72h hold-up (INV-3); INV-9 holds",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "council");
      expect(dao.params.vetoEnabled).toBe(true);
      expect(dao.params.holdUpSeconds).toBe(MICRO_HOLDUP_S);

      // --- proposal 0: community YES, council VETO -> Vetoed, no execution
      const vetoed = await proposeSweep(ctx, dao, 0);
      expect(await chainHashOf(ctx, vetoed)).toBe(vetoed.innerHash); // INV-9
      await castCommunityYes(ctx, dao, vetoed.proposal);
      await castCouncilVeto(ctx, dao, vetoed.proposal);
      expect((await readGov(ctx, vetoed.proposal, Proposal)).state).toBe(
        ProposalState.Vetoed,
      );
      // Even after every timer has elapsed, a vetoed proposal cannot execute.
      await warpSeconds(ctx, BASE_VOTING_TIME_S + MICRO_HOLDUP_S + 20);
      const vetoErr = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, vetoed, 0),
        [],
      );
      expect(vetoErr).toMatch(/invalid|cannot execute/i);
      expect(await balance(ctx, vetoed.recipient)).toBe(0);
      expect(await balance(ctx, dao.vaultPda)).toBe(VAULT_FUND);

      // --- proposal 1: community YES, NO veto -> executes after hold-up
      const passed = await proposeSweep(ctx, dao, 1);
      expect(await chainHashOf(ctx, passed)).toBe(passed.innerHash); // INV-9
      await castCommunityYes(ctx, dao, passed.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, passed.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // INV-3: before the hold-up elapses, execution is refused.
      const early = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, passed, 0),
        [],
      );
      expect(early).toMatch(/hold up time/i);

      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, passed);

      for (const addr of passed.ptAddrs) {
        const pt = await readGov(ctx, addr, ProposalTransaction);
        expect(pt.executionStatus).toBe(InstructionExecutionStatus.Success);
      }
      expect(await balance(ctx, dao.vaultPda)).toBe(0);
      expect(await balance(ctx, passed.recipient)).toBe(VAULT_FUND);
    },
    TEST_TIMEOUT,
  );
});

describe("GATE 1 VSR leg — lockup-weighted vote power under clock warp (real binaries, bankrun)", () => {
  it(
    "unlocked deposits carry ZERO weight (cannot propose); a cliff lockup carries full weight that decays as the clock advances (spec 6.3)",
    async () => {
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
        ],
        [],
      );
      const payer = ctx.payer;
      const voter = Keypair.generate();
      const mint = Keypair.generate();
      const rentLamports = Number(await mintRent(ctx));
      const voterAta = getAssociatedTokenAddressSync(mint.publicKey, voter.publicKey);

      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: voter.publicKey,
            lamports: 1_000_000_000,
          }),
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
        ],
        [mint],
      );

      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      // Realm WITH the VSR addin this time (classic SPL mint, so the
      // deployed program accepts it — the D-013 restriction is Token-2022).
      const dao = await buildCreateDaoIxs({
        mint: mint.publicKey,
        payer: payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });
      await send(ctx, dao.groups.realmSetup, []);
      await send(ctx, dao.groups.governanceSetup, []);

      // VSR voter accounts + a spl-governance TOR (deposits live in VSR;
      // the record anchors proposals/votes).
      const created = buildCreateVoterIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
      });
      const torIxs: TransactionInstruction[] = [];
      await withCreateTokenOwnerRecord(
        torIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voter.publicKey,
        mint.publicKey,
        payer.publicKey,
      );
      await send(ctx, [created.ix, ...torIxs], [voter]);
      const voterTor = await getTokenOwnerRecordAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        dao.realm,
        mint.publicKey,
        voter.publicKey,
      );

      const readWeight = async (): Promise<bigint> => {
        await send(
          ctx,
          [
            buildUpdateVoterWeightRecordIx({
              registrar: dao.registrar,
              voterAuthority: voter.publicKey,
            }),
          ],
          [],
        );
        const info = await ctx.banksClient.getAccount(created.voterWeightRecord);
        // VoterWeightRecord: 8 disc + realm 32 + mint 32 + owner 32, then
        // voter_weight u64 LE.
        return Buffer.from(info!.data).readBigUInt64LE(104);
      };

      // --- unlocked deposit: baseline weight 0 -> no proposal power
      const half = SUPPLY / 2n;
      const unlocked = buildCreateDepositEntryIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
        depositMint: mint.publicKey,
        depositEntryIndex: 0,
        kind: LockupKind.None,
        periods: 0,
        allowClawback: false,
      });
      await send(
        ctx,
        [
          unlocked.ix,
          buildDepositIx({
            registrar: dao.registrar,
            voterAuthority: voter.publicKey,
            vault: unlocked.vault,
            depositToken: voterAta,
            depositEntryIndex: 0,
            amount: half,
          }),
        ],
        [voter],
      );
      expect(await readWeight()).toBe(0n);

      // Proposal creation is refused: zero weight < the 2% threshold.
      // (VSR weight expires after the recording slot — update in the same tx.)
      const failIxs: TransactionInstruction[] = [
        buildUpdateVoterWeightRecordIx({
          registrar: dao.registrar,
          voterAuthority: voter.publicKey,
        }),
      ];
      await withCreateProposal(
        failIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        voterTor,
        "unlocked tokens cannot propose",
        "",
        mint.publicKey,
        voter.publicKey,
        0,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        payer.publicKey,
        created.voterWeightRecord,
      );
      const refused = await sendExpectFail(ctx, failIxs, [voter]);
      expect(refused).toMatch(/enough governing tokens|TokenOwnerRecord/i);

      // --- cliff lockup at the saturation horizon: full weight
      const cliff = buildCreateDepositEntryIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
        depositMint: mint.publicKey,
        depositEntryIndex: 1,
        kind: LockupKind.Cliff,
        periods: 365, // days == micro-tier lockupSaturationSeconds
        allowClawback: false,
      });
      await send(
        ctx,
        [
          cliff.ix,
          buildDepositIx({
            registrar: dao.registrar,
            voterAuthority: voter.publicKey,
            vault: cliff.vault,
            depositToken: voterAta,
            depositEntryIndex: 1,
            amount: half,
          }),
        ],
        [voter],
      );
      const lockedWeight = await readWeight();
      expect(lockedWeight).toBe(half); // saturated lockup -> 1.0x, unlocked half still 0

      // ...and with weight, proposing now succeeds.
      const okIxs: TransactionInstruction[] = [
        buildUpdateVoterWeightRecordIx({
          registrar: dao.registrar,
          voterAuthority: voter.publicKey,
        }),
      ];
      await withCreateProposal(
        okIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        voterTor,
        "locked tokens can propose",
        "",
        mint.publicKey,
        voter.publicKey,
        0,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        payer.publicKey,
        created.voterWeightRecord,
      );
      await send(ctx, okIxs, [voter]);

      // --- clock warp: cliff weight decays linearly toward expiry
      await warpSeconds(ctx, Math.floor((365 * 86400) / 2));
      const decayed = await readWeight();
      // Half the saturation horizon remains -> ~half the weight (loose
      // bounds absorb the day-granularity rounding of cliff lockups).
      expect(decayed).toBeGreaterThan((half * 45n) / 100n);
      expect(decayed).toBeLessThan((half * 55n) / 100n);

      // ...and past the cliff, lockup weight is gone entirely.
      await warpSeconds(ctx, Math.ceil((365 * 86400) / 2) + 86400);
      expect(await readWeight()).toBe(0n);
    },
    TEST_TIMEOUT,
  );

  it(
    "re-verifies D-013 with CORRECT registrar seeds: create_registrar rejects a Token-2022 community mint",
    async () => {
      // The mainnet D-013 attempt used the (then-wrong) literal-first
      // registrar seeds, so its failure proved nothing about Token-2022.
      // This is the clean experiment against the real binary.
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
          { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
        ],
        [],
      );
      const payer = ctx.payer;
      const mint = Keypair.generate();
      const rent = await ctx.banksClient.getRent();
      const lamports = Number(await rent.minimumBalance(BigInt(MINT_SIZE)));
      await send(
        ctx,
        [
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mint.publicKey,
            lamports,
            space: MINT_SIZE,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(
            mint.publicKey,
            6,
            payer.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID,
          ),
        ],
        [mint],
      );

      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      const dao = await buildCreateDaoIxs({
        mint: mint.publicKey,
        payer: payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });
      // realmSetup = [createRealm, createRegistrar, configureVotingMint];
      // the realm itself accepts Token-2022 with the D-013 token-program
      // retarget (proven live on mainnet) — send it alone, then expect the
      // registrar creation to fail on the mint's owner, NOT on seeds.
      const [createRealmIx, createRegistrarIx] = dao.groups.realmSetup;
      const retargeted = new TransactionInstruction({
        programId: createRealmIx!.programId,
        data: createRealmIx!.data,
        keys: createRealmIx!.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID)
            ? { ...k, pubkey: TOKEN_2022_PROGRAM_ID }
            : k,
        ),
      });
      await send(ctx, [retargeted], []);
      const err = await sendExpectFail(ctx, [createRegistrarIx!], []);
      expect(err).not.toMatch(/privilege escalated/i);
      expect(err).toMatch(/AccountOwnedByWrongProgram|owned by a different program|InvalidProgramId/i);
    },
    TEST_TIMEOUT,
  );
});

describe("GATE 1 cypherpunk leg (real binaries, bankrun)", () => {
  it(
    "the realm has NO council accounts (structural), the 72h hold-up gates execution (INV-3), and the custody chain moves the vault funds; INV-9 holds",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");
      expect(dao.params.vetoEnabled).toBe(false);
      expect(dao.params.holdUpSeconds).toBe(MICRO_HOLDUP_S); // max(24h, micro floor)
      expect(dao.councilMint).toBeNull();

      // Structural no-veto: the realm itself has no council mint registered.
      const realm = await readGov(ctx, dao.realm, Realm);
      expect(realm.config.councilMint).toBeUndefined();

      const made = await proposeSweep(ctx, dao, 0);
      expect(await chainHashOf(ctx, made)).toBe(made.innerHash); // INV-9
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // INV-3: refused before the hold-up has elapsed...
      const early = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, made, 0),
        [],
      );
      expect(early).toMatch(/hold up time/i);
      expect(await balance(ctx, dao.vaultPda)).toBe(VAULT_FUND);

      // ...and the full Squads chain executes once it has.
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      expect(await balance(ctx, dao.vaultPda)).toBe(0);
      expect(await balance(ctx, made.recipient)).toBe(VAULT_FUND);
      expect((await readGov(ctx, made.proposal, Proposal)).state).toBe(
        ProposalState.Completed,
      );
    },
    TEST_TIMEOUT,
  );
});
