/**
 * GATE 1 — partial, mainnet, sovereign mode, phase 2 (operator-funded,
 * D-008; budget-constrained continuation of mainnet-gate1-sovereign.ts).
 *
 * Phase 1 proved on the REAL pump token: advance-derived realm/governance/
 * native-treasury, INV-7 sole-member custody, and Token-2022 governance
 * deposits (D-013). Its proposal leg is blocked by the pre-D-015 config's
 * ~0.102 SOL security deposit, which the budget cannot float.
 *
 * Phase 2 finishes the untested legs — proposal -> vote -> finalize ->
 * SPL-Gov execute -> Squads custody chain -> real lamports move — on a
 * fresh smoke DAO built with the FIXED config (depositExemptProposalCount
 * 10: also verifies D-015 live). The community mint is a synthetic
 * Token-2022 mint (supply 200k to the buyer, authorities nulled, INV-5
 * shape); the pump-specific interactions are already covered by phase 1 /
 * GATE 0a evidence. Governance params here are PRODUCTION values from
 * resolveGovernanceParams (sovereign/micro, hold-up 0) except
 * baseVotingTime 3600s (program minimum; production default is 3 days).
 *
 * Stage-checkpointed and resumable like phase 1; evidence in
 * .gate-evidence/gate1-sovereign-p2-mainnet.json.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import {
  Vote,
  VoteChoice,
  VoteKind,
  VoteType,
  createInstructionData,
  getGovernanceAccount,
  getProposal,
  getProposalTransactionAddress,
  getRealm,
  getTokenOwnerRecordAddress,
  getVoteRecordAddress,
  ProposalState,
  ProposalTransaction,
  InstructionExecutionStatus,
  TokenOwnerRecord,
  VoteRecord,
  withCastVote,
  withCreateProposal,
  withCreateTokenOwnerRecord,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
  withInsertTransaction,
  withRelinquishVote,
  withSignOffProposal,
  withWithdrawGoverningTokens,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import {
  OnlinePumpSdk,
  PumpSdk,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import { deriveGovernanceChainFromMint } from "../packages/sdk/src/pda";
import {
  buildCreateTreasuryIx,
  deriveTreasuryPdas,
  fetchProgramConfigTreasury,
} from "../packages/sdk/src/treasury";
import {
  fetchNextTransactionIndex,
  unwrap,
  wrap,
} from "../packages/sdk/src/execution-adapter";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import { computeInstructionSetHash } from "../packages/backend/src/artifacts";
import { loadOrCreateKeypair } from "./init-wallets";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OLD_MINT = new PublicKey("E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC");
const PROGRAM_VERSION = 3;
const EVIDENCE = join(".gate-evidence", "gate1-sovereign-p2-mainnet.json");

const BASE_VOTING_TIME_S = 3600; // program minimum; only smoke deviation
const SUPPLY_TOKENS = 200_000n * 10n ** 6n; // synthetic supply, all to buyer
const VAULT_PREFUND = 890_880; // rent floor; the lamports the proposal sweeps

interface Evidence {
  gate: string;
  cluster: string;
  note: string;
  config: Record<string, unknown>;
  stages: Record<string, Record<string, unknown>>;
  findings: string[];
  result?: string;
}

function loadEvidence(): Evidence {
  if (existsSync(EVIDENCE)) {
    return JSON.parse(readFileSync(EVIDENCE, "utf8")) as Evidence;
  }
  return {
    gate: "1-partial-sovereign-p2",
    cluster: RPC_URL,
    note:
      "phase 2 (budget-constrained): production sovereign/micro params via " +
      "resolveGovernanceParams, holdUp 0, depositExemptProposalCount 10 " +
      "(D-015 fix verified live). Synthetic Token-2022 community mint; " +
      "baseVotingTime 3600s is the only config deviation (program min).",
    config: { baseVotingTimeSeconds: BASE_VOTING_TIME_S, supplyRaw: SUPPLY_TOKENS.toString() },
    stages: {},
    findings: [],
  };
}

const evidence = loadEvidence();
function save() {
  mkdirSync(".gate-evidence", { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2));
}
function stageDone(name: string): boolean {
  return evidence.stages[name] !== undefined;
}
function record(name: string, data: Record<string, unknown>) {
  evidence.stages[name] = { ...evidence.stages[name], ...data, at: new Date().toISOString() };
  save();
}

async function sendTx(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...ixs,
  );
  tx.feePayer = signers[0]!.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
  console.log(`  ${label}: ${sig}`);
  return sig;
}

async function simulate(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  label: string,
): Promise<{ err: unknown; logs: string[] } | null> {
  // replaceRecentBlockhash:true means any well-formed blockhash compiles —
  // skip getLatestBlockhash to stay under the public RPC rate limit.
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: ixs,
  }).compileToLegacyMessage();
  const sim = await connection.simulateTransaction(new VersionedTransaction(msg), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (sim.value.err === null) {
    console.log(`  sim ${label}: OK (${sim.value.unitsConsumed} CU)`);
    return null;
  }
  console.log(`  sim ${label}: FAILED ${JSON.stringify(sim.value.err)}`);
  for (const l of sim.value.logs ?? []) console.log(`    ${l}`);
  return { err: sim.value.err, logs: sim.value.logs ?? [] };
}

function retargetTokenProgram(ixs: TransactionInstruction[]): TransactionInstruction[] {
  return ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID) ? { ...k, pubkey: TOKEN_2022_PROGRAM_ID } : k,
        ),
      }),
  );
}

/** D-013: deployed v3.1.4 needs the mint appended for Token-2022 moves. */
function appendMint(ix: TransactionInstruction, mint: PublicKey) {
  ix.keys.push({ pubkey: mint, isSigner: false, isWritable: false });
}

async function logBalances(connection: Connection, wallets: Record<string, PublicKey>) {
  for (const [name, pk] of Object.entries(wallets)) {
    console.log(`  balance ${name}: ${(await connection.getBalance(pk)) / 1e9} SOL`);
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadOrCreateKeypair(".wallets", "mainnet-gas");
  const buyer = loadOrCreateKeypair(".wallets", "mainnet-buyer");
  // Persisted so the multisig/realm PDAs survive re-runs.
  const mintKp = loadOrCreateKeypair(".wallets", "smoke2-mint");
  const createKey = loadOrCreateKeypair(".wallets", "smoke2-createkey");
  const MINT = mintKp.publicKey;
  const chain = deriveGovernanceChainFromMint(MINT);
  const { multisigPda, vaultPda } = deriveTreasuryPdas(createKey.publicKey);
  evidence.config = {
    ...evidence.config,
    mint: MINT.toBase58(),
    multisigPda: multisigPda.toBase58(),
    squadsVault: vaultPda.toBase58(),
    realm: chain.realm.toBase58(),
    governance: chain.governance.toBase58(),
    nativeTreasury: chain.nativeTreasury.toBase58(),
  };
  save();
  console.log(`mint ${MINT.toBase58()}`);
  console.log(`multisig ${multisigPda.toBase58()} vault ${vaultPda.toBase58()}`);
  console.log(`realm ${chain.realm.toBase58()}`);
  console.log(`nativeTreasury ${chain.nativeTreasury.toBase58()}`);
  await logBalances(connection, { deployer: deployer.publicKey, buyer: buyer.publicKey });

  // ---- stage recover-old: pull funds back out of the phase-1 smoke DAO ----
  if (!stageDone("recover-old")) {
    console.log("\n[recover-old]");
    const sigs: Record<string, string> = {};
    const oldRealm = deriveGovernanceChainFromMint(OLD_MINT).realm;
    const oldAta = getAssociatedTokenAddressSync(
      OLD_MINT,
      buyer.publicKey,
      true,
      TOKEN_2022_PROGRAM_ID,
    );
    const withdrawIxs: TransactionInstruction[] = [];
    await withWithdrawGoverningTokens(
      withdrawIxs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      oldRealm,
      oldAta,
      OLD_MINT,
      buyer.publicKey,
    );
    const patched = retargetTokenProgram(withdrawIxs);
    appendMint(patched[patched.length - 1]!, OLD_MINT);
    sigs["withdraw-old"] = await sendTx(connection, patched, [buyer], "withdraw-old");

    // sell the recovered tokens back to the curve, close the ATA
    const online = new OnlinePumpSdk(connection);
    const offline = new PumpSdk();
    const raw = (await connection.getTokenAccountBalance(oldAta)).value.amount;
    if (raw !== "0") {
      const global = await online.fetchGlobal();
      const sellState = await online.fetchSellState(
        OLD_MINT,
        buyer.publicKey,
        TOKEN_2022_PROGRAM_ID,
      );
      const amount = new BN(raw);
      const supply = await connection.getTokenSupply(OLD_MINT);
      const solOut = getSellSolAmountFromTokenAmount({
        global,
        feeConfig: null,
        mintSupply: new BN(supply.value.amount),
        bondingCurve: sellState.bondingCurve,
        amount,
      });
      const sellIxs = await offline.sellInstructions({
        global,
        bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
        bondingCurve: sellState.bondingCurve,
        mint: OLD_MINT,
        user: buyer.publicKey,
        amount,
        solAmount: solOut,
        slippage: 10,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        mayhemMode: false,
      });
      sigs["sell-old"] = await sendTx(connection, sellIxs, [buyer], "sell-old");
    }
    sigs["close-old-ata"] = await sendTx(
      connection,
      [
        createCloseAccountInstruction(
          oldAta,
          buyer.publicKey,
          buyer.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
      [buyer],
      "close-old-ata",
    );
    record("recover-old", { sigs });
    await logBalances(connection, { deployer: deployer.publicKey, buyer: buyer.publicKey });
  }

  const buyerAta = getAssociatedTokenAddressSync(
    MINT,
    buyer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  // ---- stage mint: synthetic Token-2022 community mint, INV-5 shape ----
  if (!stageDone("mint")) {
    console.log("\n[mint]");
    const mintLen = getMintLen([]);
    const rent = await connection.getMinimumBalanceForRentExemption(mintLen);
    const ixs = [
      SystemProgram.createAccount({
        fromPubkey: deployer.publicKey,
        newAccountPubkey: MINT,
        lamports: rent,
        space: mintLen,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        MINT,
        6,
        deployer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        deployer.publicKey,
        buyerAta,
        buyer.publicKey,
        MINT,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToInstruction(
        MINT,
        buyerAta,
        deployer.publicKey,
        SUPPLY_TOKENS,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
      // INV-5: no mint authority survives launch.
      createSetAuthorityInstruction(
        MINT,
        deployer.publicKey,
        AuthorityType.MintTokens,
        null,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ];
    const sig = await sendTx(connection, ixs, [deployer, mintKp], "mint");
    const mintInfo = await connection.getParsedAccountInfo(MINT);
    const parsed = (mintInfo.value?.data as { parsed: { info: { mintAuthority: string | null } } })
      .parsed.info;
    if (parsed.mintAuthority !== null) throw new Error("INV-5: mint authority not null");
    record("mint", { sig, supply: SUPPLY_TOKENS.toString(), inv5MintAuthorityNull: true });
  }

  // ---- stage treasury: Squads vault, sole member = predicted treasury ----
  if (!stageDone("treasury")) {
    console.log("\n[treasury]");
    const programConfigTreasury = await fetchProgramConfigTreasury(connection);
    const { ix } = buildCreateTreasuryIx({
      payer: deployer.publicKey,
      predictedNativeTreasury: chain.nativeTreasury,
      createKey: createKey.publicKey,
      programConfigTreasury,
    });
    const prefund = SystemProgram.transfer({
      fromPubkey: deployer.publicKey,
      toPubkey: vaultPda,
      lamports: VAULT_PREFUND,
    });
    const sig = await sendTx(connection, [ix, prefund], [deployer, createKey], "treasury");
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
    const members = ms.members.map((m) => m.key.toBase58());
    if (members.length !== 1 || members[0] !== chain.nativeTreasury.toBase58()) {
      throw new Error(`INV-7 violated: members = ${members.join(",")}`);
    }
    record("treasury", { sig, inv7SoleMemberIsNativeTreasury: true, prefund: VAULT_PREFUND });
    console.log("  INV-7 holds: sole member == native treasury PDA (realm not yet created)");
  }

  // ---- stages realm-setup / governance-setup: PRODUCTION params ----
  const params = resolveGovernanceParams({
    mode: "sovereign",
    tier: "micro",
    communitySupply: SUPPLY_TOKENS,
    sovereignHoldUpSeconds: 0,
  });
  const dao = await buildCreateDaoIxs({
    mint: MINT,
    payer: deployer.publicKey,
    mode: "sovereign",
    params,
    baseVotingTimeSeconds: BASE_VOTING_TIME_S,
    communityVoterWeightAddin: null, // D-013
  });
  if (!dao.nativeTreasury.equals(chain.nativeTreasury)) {
    throw new Error("built nativeTreasury != advance-derived prediction");
  }

  // D-009: realm+governance rent would push the deployer below the rent
  // floor; the buyer wallet carries the surplus after recover-old.
  if (!stageDone("rebalance")) {
    console.log("\n[rebalance]");
    const sig = await sendTx(
      connection,
      [
        SystemProgram.transfer({
          fromPubkey: buyer.publicKey,
          toPubkey: deployer.publicKey,
          lamports: 7_000_000,
        }),
      ],
      [buyer],
      "rebalance-buyer->deployer",
    );
    record("rebalance", { sig, lamports: 7_000_000 });
  }

  if (!stageDone("realm-setup")) {
    console.log("\n[realm-setup]");
    const ixs = retargetTokenProgram(dao.groups.realmSetup);
    const sim = await simulate(connection, ixs, deployer.publicKey, "realmSetup");
    if (sim) throw new Error("realmSetup simulation failed");
    const sig = await sendTx(connection, ixs, [deployer], "realm-setup");
    record("realm-setup", { sig, realm: dao.realm.toBase58(), params: {
      quorumPercent: params.quorumPercent,
      proposalThresholdTokens: params.proposalThresholdTokens.toString(),
      holdUpSeconds: params.holdUpSeconds,
    }});
  }

  if (!stageDone("governance-setup")) {
    console.log("\n[governance-setup]");
    const ixs = retargetTokenProgram(dao.groups.governanceSetup);
    const sim = await simulate(connection, ixs, deployer.publicKey, "governanceSetup");
    if (sim) throw new Error("governanceSetup simulation failed");
    const sig = await sendTx(connection, ixs, [deployer], "governance-setup");
    const realmAcc = await getRealm(connection, dao.realm);
    if (realmAcc.account.authority?.toBase58() !== dao.governance.toBase58()) {
      throw new Error("realm authority is not the governance PDA");
    }
    record("governance-setup", {
      sig,
      governance: dao.governance.toBase58(),
      nativeTreasury: dao.nativeTreasury.toBase58(),
      realmAuthorityIsGovernance: true,
    });
  }

  // ---- stage voting-power: deposit the full synthetic supply ----
  const buyerTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    MINT,
    buyer.publicKey,
  );
  if (!stageDone("voting-power")) {
    console.log("\n[voting-power]");
    const ixs: TransactionInstruction[] = [];
    await withCreateTokenOwnerRecord(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      buyer.publicKey,
      MINT,
      buyer.publicKey,
    );
    await withDepositGoverningTokens(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      buyerAta,
      MINT,
      buyer.publicKey,
      buyer.publicKey,
      buyer.publicKey,
      new BN(SUPPLY_TOKENS.toString()),
    );
    const patched = retargetTokenProgram(ixs);
    appendMint(patched[patched.length - 1]!, MINT);
    const sim = await simulate(connection, patched, buyer.publicKey, "deposit(token22)");
    if (sim) throw new Error("deposit simulation failed");
    const sig = await sendTx(connection, patched, [buyer], "deposit");
    record("voting-power", { sig, deposited: SUPPLY_TOKENS.toString(), tor: buyerTor.toBase58() });
  }

  // ---- stage proposal ----
  if (!stageDone("proposal")) {
    console.log("\n[proposal]");
    const vaultLamports = await connection.getBalance(vaultPda);
    if (vaultLamports === 0) throw new Error("vault is empty; nothing to sweep");
    const innerIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: deployer.publicKey,
      lamports: vaultLamports,
    });
    const innerHash = computeInstructionSetHash([innerIx]);
    const txIndex = await fetchNextTransactionIndex(connection, multisigPda);
    const wrapped = wrap([innerIx], {
      multisigPda,
      vaultIndex: 0,
      transactionIndex: txIndex,
      member: chain.nativeTreasury,
    });

    const createIxs: TransactionInstruction[] = [];
    const proposal = await withCreateProposal(
      createIxs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      dao.governance,
      buyerTor,
      "GATE1-p2: sweep vault via custody chain",
      "",
      MINT,
      buyer.publicKey,
      0,
      VoteType.SINGLE_CHOICE,
      ["Approve"],
      true,
      buyer.publicKey,
    );
    const sim1 = await simulate(connection, createIxs, buyer.publicKey, "createProposal");
    if (sim1) throw new Error("createProposal simulation failed");
    const sigCreate = await sendTx(connection, createIxs, [buyer], "create-proposal");

    const insertSigs: string[] = [];
    for (const [i, ix] of wrapped.entries()) {
      const ixs: TransactionInstruction[] = [];
      await withInsertTransaction(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.governance,
        proposal,
        buyerTor,
        buyer.publicKey,
        i,
        0,
        0,
        [createInstructionData(ix)],
        buyer.publicKey,
      );
      insertSigs.push(await sendTx(connection, ixs, [buyer], `insert-tx-${i}`));
    }

    const signOffIxs: TransactionInstruction[] = [];
    withSignOffProposal(
      signOffIxs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      dao.governance,
      proposal,
      buyer.publicKey,
      undefined,
      buyerTor,
    );
    const sigSignOff = await sendTx(connection, signOffIxs, [buyer], "sign-off");

    record("proposal", {
      proposal: proposal.toBase58(),
      squadsTransactionIndex: txIndex.toString(),
      innerInstructionSetHash: innerHash,
      vaultLamportsToSweep: vaultLamports,
      sigCreate,
      insertSigs,
      sigSignOff,
      d015VerifiedNoSecurityDeposit: true,
    });
  }
  const proposal = new PublicKey(evidence.stages["proposal"]!.proposal as string);

  // ---- stage cast-vote ----
  if (!stageDone("cast-vote")) {
    console.log("\n[cast-vote]");
    const ixs: TransactionInstruction[] = [];
    await withCastVote(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      dao.governance,
      proposal,
      buyerTor,
      buyerTor,
      buyer.publicKey,
      MINT,
      new Vote({
        voteType: VoteKind.Approve,
        approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
        deny: undefined,
        veto: undefined,
      }),
      buyer.publicKey,
    );
    const sim = await simulate(connection, ixs, buyer.publicKey, "castVote");
    if (sim) throw new Error("castVote simulation failed");
    const sig = await sendTx(connection, ixs, [buyer], "cast-vote");
    const p = await getProposal(connection, proposal);
    record("cast-vote", {
      sig,
      state: ProposalState[p.account.state],
      yesVotes: p.account.getYesVoteCount().toString(),
    });
  }

  // ---- stage finalize ----
  if (!stageDone("finalize")) {
    console.log("\n[finalize]");
    let p = await getProposal(connection, proposal);
    const votingAt = p.account.votingAt ? Number(p.account.votingAt.toString()) : 0;
    const wait = votingAt + BASE_VOTING_TIME_S + 10 - Math.floor(Date.now() / 1000);
    if (p.account.state === ProposalState.Voting && wait > 0) {
      console.log(`  waiting ${wait}s for the voting window to elapse...`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    const ixs: TransactionInstruction[] = [];
    await withFinalizeVote(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      dao.governance,
      proposal,
      buyerTor,
      MINT,
    );
    const sig = await sendTx(connection, ixs, [buyer], "finalize-vote");
    p = await getProposal(connection, proposal);
    const state = ProposalState[p.account.state];
    console.log(`  proposal state: ${state}`);
    if (p.account.state !== ProposalState.Succeeded) {
      throw new Error(`proposal did not succeed: ${state}`);
    }
    record("finalize", { sig, state });
  }

  // ---- stage execute: INV-3 (hold-up 0), INV-9 (hash), funds move ----
  if (!stageDone("execute")) {
    console.log("\n[execute]");
    const vaultBefore = await connection.getBalance(vaultPda);
    const deployerBefore = await connection.getBalance(deployer.publicKey);

    const onChainWrapped: TransactionInstruction[] = [];
    const ptAddrs: PublicKey[] = [];
    for (let i = 0; i < 4; i++) {
      const ptAddr = await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        proposal,
        0,
        i,
      );
      ptAddrs.push(ptAddr);
      const pt = await getGovernanceAccount(connection, ptAddr, ProposalTransaction);
      for (const d of pt.account.getAllInstructions()) {
        onChainWrapped.push(
          new TransactionInstruction({
            programId: d.programId,
            keys: d.accounts.map(
              (a: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }) => ({
                pubkey: a.pubkey,
                isSigner: a.isSigner,
                isWritable: a.isWritable,
              }),
            ),
            data: Buffer.from(d.data),
          }),
        );
      }
    }
    const txIndex = BigInt(evidence.stages["proposal"]!.squadsTransactionIndex as string);
    const recovered = unwrap(onChainWrapped, {
      multisigPda,
      vaultIndex: 0,
      transactionIndex: txIndex,
      member: chain.nativeTreasury,
    });
    const onChainHash = computeInstructionSetHash(recovered);
    const artifactHash = evidence.stages["proposal"]!.innerInstructionSetHash as string;
    if (onChainHash !== artifactHash) {
      throw new Error(`INV-9 violated: ${onChainHash} != ${artifactHash}`);
    }
    console.log(`  INV-9 holds: on-chain hash == artifact (${onChainHash.slice(0, 16)}...)`);

    const executeSigs: string[] = [];
    const treasuryTopUps: Record<string, string> = {};
    for (const [i, ptAddr] of ptAddrs.entries()) {
      // Idempotent on resume: a rate-limit abort mid-stage leaves some
      // ProposalTransactions already executed on-chain.
      const fresh = await getGovernanceAccount(connection, ptAddr, ProposalTransaction);
      if (fresh.account.executionStatus === InstructionExecutionStatus.Success) {
        console.log(`  execute-${i}: already executed, skipping`);
        executeSigs.push("already-executed");
        continue;
      }
      const ixs: TransactionInstruction[] = [];
      await withExecuteTransaction(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.governance,
        proposal,
        ptAddr,
        [createInstructionData(onChainWrapped[i]!)],
      );
      // The native treasury is Squads' rent payer during execution
      // (VaultTransactionCreate / ProposalCreate create accounts). The
      // 890,880 prefund is only its own floor — fund the exact transfer
      // the failing sim asks for, so the floor survives each CPI.
      let sim = await simulate(connection, ixs, buyer.publicKey, `execute-${i}`);
      for (let round = 0; sim && round < 3; round++) {
        const m = sim.logs
          .join("\n")
          .match(/insufficient lamports \d+, need (\d+)/);
        if (!m) break;
        const topUp = Number(m[1]!);
        const fundSig = await sendTx(
          connection,
          [
            SystemProgram.transfer({
              fromPubkey: buyer.publicKey,
              toPubkey: chain.nativeTreasury,
              lamports: topUp,
            }),
          ],
          [buyer],
          `fund-treasury-${i}`,
        );
        treasuryTopUps[`execute-${i}`] = `${topUp}:${fundSig}`;
        sim = await simulate(connection, ixs, buyer.publicKey, `execute-${i}`);
      }
      if (sim) throw new Error(`execute-${i} simulation failed`);
      executeSigs.push(await sendTx(connection, ixs, [buyer], `execute-${i}`));
      await new Promise((r) => setTimeout(r, 3000)); // public-RPC pacing
    }

    const vaultAfter = await connection.getBalance(vaultPda);
    const deployerAfter = await connection.getBalance(deployer.publicKey);
    console.log(`  squads vault: ${vaultBefore} -> ${vaultAfter}`);
    console.log(`  deployer:     ${deployerBefore} -> ${deployerAfter}`);
    if (vaultAfter !== 0) throw new Error("vault not fully swept by the proposal");
    record("execute", {
      executeSigs,
      treasuryTopUps,
      inv9OnChainHash: onChainHash,
      vaultBefore,
      vaultAfter,
      deployerBefore,
      deployerAfter,
    });
  }

  // ---- stage cleanup ----
  if (!stageDone("cleanup")) {
    console.log("\n[cleanup]");
    const sigs: Record<string, string> = {};
    const voteRecord = await getVoteRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      proposal,
      buyerTor,
    );
    // Each sub-step guards on on-chain state so a mid-stage abort resumes
    // cleanly (the stage checkpoint is only written at the end).
    // After voting ends the VoteRecord persists with isRelinquished set —
    // existence alone doesn't mean there is anything left to relinquish.
    const vrInfo = await connection.getAccountInfo(voteRecord);
    const needRelinquish = vrInfo
      ? !(await getGovernanceAccount(connection, voteRecord, VoteRecord)).account
          .isRelinquished
      : false;
    if (needRelinquish) {
      const relinquishIxs: TransactionInstruction[] = [];
      await withRelinquishVote(
        relinquishIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        proposal,
        buyerTor,
        MINT,
        voteRecord,
        buyer.publicKey,
        buyer.publicKey,
      );
      sigs["relinquish"] = await sendTx(connection, relinquishIxs, [buyer], "relinquish");
    } else {
      console.log("  relinquish: already relinquished, skipping");
    }

    const tor = await getGovernanceAccount(connection, buyerTor, TokenOwnerRecord);
    if (tor.account.governingTokenDepositAmount.gtn(0)) {
      const withdrawIxs: TransactionInstruction[] = [];
      await withWithdrawGoverningTokens(
        withdrawIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        buyerAta,
        MINT,
        buyer.publicKey,
      );
      const patched = retargetTokenProgram(withdrawIxs);
      appendMint(patched[patched.length - 1]!, MINT);
      sigs["withdraw"] = await sendTx(connection, patched, [buyer], "withdraw-deposit");
    } else {
      console.log("  withdraw-deposit: nothing deposited, skipping");
    }

    // synthetic tokens have no market; close the ATA for rent (tokens burn)
    if (await connection.getAccountInfo(buyerAta)) {
      const burnAndClose: TransactionInstruction[] = [];
      const { createBurnInstruction } = await import("@solana/spl-token");
      burnAndClose.push(
        createBurnInstruction(
          buyerAta,
          MINT,
          buyer.publicKey,
          SUPPLY_TOKENS,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
        createCloseAccountInstruction(
          buyerAta,
          buyer.publicKey,
          buyer.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      sigs["burn-and-close"] = await sendTx(connection, burnAndClose, [buyer], "burn-and-close");
    } else {
      console.log("  burn-and-close: ATA gone, skipping");
    }

    // consolidate buyer -> deployer (gas wallet). The buyer must end at
    // EXACTLY 0 (a nonzero balance below the rent floor is rejected), so
    // send a bare tx — no compute-budget ixs — whose fee is exactly 5,000.
    const BASE_FEE = 5_000;
    const buyerBal = await connection.getBalance(buyer.publicKey);
    if (buyerBal > BASE_FEE) {
      const bare = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: buyer.publicKey,
          toPubkey: deployer.publicKey,
          lamports: buyerBal - BASE_FEE,
        }),
      );
      bare.feePayer = buyer.publicKey;
      sigs["consolidate"] = await sendAndConfirmTransaction(connection, bare, [buyer], {
        commitment: "confirmed",
      });
      console.log(`  consolidate-buyer: ${sigs["consolidate"]}`);
    }
    record("cleanup", { sigs });
  }

  evidence.result = "PASS";
  save();
  await logBalances(connection, { deployer: deployer.publicKey, buyer: buyer.publicKey });
  console.log("\nGATE 1 (partial, mainnet sovereign, phase 2): PASS");
  console.log(`evidence: ${EVIDENCE}`);
}

main().catch((e) => {
  console.error(e);
  save();
  process.exit(1);
});
