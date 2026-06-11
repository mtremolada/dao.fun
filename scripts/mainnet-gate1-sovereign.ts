/**
 * GATE 1 — partial, mainnet, sovereign mode (operator-funded, D-008 regime).
 *
 * Stands up the real DAO for the GATE 0a token (its Squads vault already
 * exists with the predicted native treasury as sole member), then drives a
 * real community proposal through the full custody chain:
 *
 *   vote -> SPL Governance execute -> native treasury "signs" ->
 *   Squads vaultTransactionCreate/proposalCreate/approve/execute ->
 *   the test vault's lamports actually move (INV-3/INV-7/INV-9 live).
 *
 * Mainnet has no clock control, so this run uses recorded SMOKE deviations
 * (DECISIONS.md D-014): baseVotingTime 600s, Absolute max community vote
 * weight (200k tokens), proposal threshold 50k tokens, and — because the
 * deployed VSR is classic-SPL-Token-only (D-013) — either a VSR baseline
 * weight of 1x or a realm with no addin and plain governance deposits,
 * decided by free on-chain simulation before anything is sent.
 *
 * Stage-checkpointed and resumable: every stage records its txs in
 * .gate-evidence/gate1-sovereign-mainnet.json and is skipped on re-run.
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
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
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
  withCastVote,
  withCreateProposal,
  withCreateTokenOwnerRecord,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
  withInsertTransaction,
  withRefundProposalDeposit,
  withRelinquishVote,
  withSignOffProposal,
  withWithdrawGoverningTokens,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MintMaxVoteWeightSource,
  buildCreateDaoIxs,
} from "../packages/sdk/src/governance";
import { deriveGovernanceChainFromMint } from "../packages/sdk/src/pda";
import {
  fetchNextTransactionIndex,
  unwrap,
  wrap,
} from "../packages/sdk/src/execution-adapter";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import { computeInstructionSetHash } from "../packages/backend/src/artifacts";
import { loadOrCreateKeypair } from "./init-wallets";

const RPC_URL = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const MINT = new PublicKey("E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC");
const MULTISIG = new PublicKey("5572XY2dwdq2srxLBRgDeVzUkNxuGcBafn9xqStko8q8");
const SQUADS_VAULT = new PublicKey("3qnu5xeFW2vwHPK116PccxwuBTqvQqfikp73tvVR4uJA");
const PROGRAM_VERSION = 3;
const EVIDENCE = join(".gate-evidence", "gate1-sovereign-mainnet.json");

// SMOKE deviations (D-014) — all recorded in evidence:
const BASE_VOTING_TIME_S = 3600; // program minimum (1h), enforced by spl-gov
const MAX_VOTE_WEIGHT_ABSOLUTE = 200_000n * 10n ** 6n; // 200k tokens
const PROPOSAL_THRESHOLD = 50_000n * 10n ** 6n; // 50k tokens
const BUY_LAMPORTS = 3_000_000; // ~107k tokens at curve start
const BUYER_FUNDING = 45_000_000; // 0.045 SOL working capital (mostly rent)

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
    gate: "1-partial-sovereign",
    cluster: RPC_URL,
    note:
      "operator-funded mainnet run (D-008). Sovereign mode, hold-up 0. " +
      "Smoke deviations per D-014: baseVotingTime 3600s (program min), Absolute max vote " +
      "weight 200k tokens, proposal threshold 50k tokens.",
    config: {
      mint: MINT.toBase58(),
      multisigPda: MULTISIG.toBase58(),
      squadsVault: SQUADS_VAULT.toBase58(),
      baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      maxVoteWeightAbsolute: MAX_VOTE_WEIGHT_ABSOLUTE.toString(),
      proposalThresholdRaw: PROPOSAL_THRESHOLD.toString(),
    },
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
function finding(text: string) {
  console.log(`FINDING: ${text}`);
  evidence.findings.push(text);
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

/** Free dry-run; returns null on success, else the error + logs. */
async function simulate(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: PublicKey,
  label: string,
): Promise<{ err: unknown; logs: string[] } | null> {
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
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

/**
 * The JS governance builders hardcode the classic token program for the
 * governing-token holding accounts; our community mint is Token-2022. The
 * deployed program (v3.1.4) resolves the token program from the account
 * passed — retarget it and let simulation arbitrate.
 */
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

function smokeParams() {
  return {
    lockupSaturationSeconds: 365 * 86400,
    quorumPercent: 25, // micro tier floor (production value)
    proposalThresholdTokens: PROPOSAL_THRESHOLD,
    holdUpSeconds: 0, // sovereign, explicitly chosen (production-legal)
    vetoEnabled: false,
  };
}

async function buildDao(useVsr: boolean, payer: PublicKey) {
  return buildCreateDaoIxs({
    mint: MINT,
    payer,
    mode: "sovereign",
    params: smokeParams(),
    baseVotingTimeSeconds: BASE_VOTING_TIME_S,
    communityMaxVoteWeightSource: new MintMaxVoteWeightSource({
      type: 1, // Absolute
      value: new BN(MAX_VOTE_WEIGHT_ABSOLUTE.toString()),
    }),
    ...(useVsr
      ? { baselineVoteWeightScaledFactor: 1_000_000_000n } // D-014 smoke knob
      : { communityVoterWeightAddin: null }), // D-013 fallback
  });
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const deployer = loadOrCreateKeypair(".wallets", "mainnet-gas");
  const buyer = loadOrCreateKeypair(".wallets", "mainnet-buyer");
  const chain = deriveGovernanceChainFromMint(MINT);
  console.log(`deployer ${deployer.publicKey.toBase58()}`);
  console.log(`realm ${chain.realm.toBase58()}`);
  console.log(`governance ${chain.governance.toBase58()}`);
  console.log(`nativeTreasury ${chain.nativeTreasury.toBase58()}`);

  // ---- stage probe-vsr: free simulations decide the architecture path ----
  if (!stageDone("probe-vsr")) {
    console.log("\n[probe-vsr] simulating realm setup variants (free)");
    const vsrDao = await buildDao(true, deployer.publicKey);
    const vsrSim = await simulate(
      connection,
      retargetTokenProgram(vsrDao.groups.realmSetup),
      deployer.publicKey,
      "realmSetup+VSR(token22)",
    );
    if (vsrSim !== null) {
      finding(
        "D-013 (on-chain evidence): VSR leg of realm setup fails for a " +
          "Token-2022 community mint. Logs captured in stage record.",
      );
      const plainDao = await buildDao(false, deployer.publicKey);
      const plainSim = await simulate(
        connection,
        retargetTokenProgram(plainDao.groups.realmSetup),
        deployer.publicKey,
        "realmSetup no-addin(token22)",
      );
      if (plainSim !== null) {
        finding(
          "CRITICAL: SPL Governance realm creation itself rejects the " +
            "Token-2022 community mint. No DAO is possible for pump v2 " +
            "mints with the deployed programs. Full stop.",
        );
        record("probe-vsr", {
          useVsr: false,
          vsrSimError: vsrSim.err,
          vsrSimLogs: vsrSim.logs,
          plainSimError: plainSim.err,
          plainSimLogs: plainSim.logs,
          verdict: "ABORT",
        });
        evidence.result = "FAIL (governance program rejects Token-2022)";
        save();
        process.exit(1);
      }
      record("probe-vsr", {
        useVsr: false,
        vsrSimError: vsrSim.err,
        vsrSimLogs: vsrSim.logs.slice(-15),
        verdict: "fallback: realm without addin, plain governance deposits",
      });
    } else {
      record("probe-vsr", { useVsr: true, verdict: "VSR accepted Token-2022 (!)" });
    }
  }
  const useVsr = evidence.stages["probe-vsr"]!.useVsr as boolean;
  console.log(`\npath: ${useVsr ? "VSR (baseline 1x smoke)" : "no addin, plain deposits"}`);
  const dao = await buildDao(useVsr, deployer.publicKey);

  // ---- stage realm-setup ----
  if (!stageDone("realm-setup")) {
    console.log("\n[realm-setup]");
    const ixs = retargetTokenProgram(dao.groups.realmSetup);
    const sig = await sendTx(connection, ixs, [deployer], "realm-setup");
    record("realm-setup", { sig, realm: dao.realm.toBase58() });
  }

  // ---- stage governance-setup ----
  if (!stageDone("governance-setup")) {
    console.log("\n[governance-setup]");
    const ixs = retargetTokenProgram(dao.groups.governanceSetup);
    const sim = await simulate(connection, ixs, deployer.publicKey, "governanceSetup");
    if (sim) throw new Error("governanceSetup simulation failed; see logs");
    const sig = await sendTx(connection, ixs, [deployer], "governance-setup");

    // Assertions: predictions hold; realm is self-governed; INV-7 custody.
    if (!dao.nativeTreasury.equals(chain.nativeTreasury)) {
      throw new Error("built nativeTreasury != advance-derived prediction");
    }
    const realmAcc = await getRealm(connection, dao.realm);
    const authority = realmAcc.account.authority?.toBase58();
    if (authority !== dao.governance.toBase58()) {
      throw new Error(`realm authority is ${authority}, expected the governance PDA`);
    }
    const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, MULTISIG);
    const members = ms.members.map((m) => m.key.toBase58());
    if (members.length !== 1 || members[0] !== chain.nativeTreasury.toBase58()) {
      throw new Error(`INV-7 violated: multisig members = ${members.join(",")}`);
    }
    record("governance-setup", {
      sig,
      governance: dao.governance.toBase58(),
      nativeTreasury: dao.nativeTreasury.toBase58(),
      realmAuthorityIsGovernance: true,
      inv7SoleMemberIsNativeTreasury: true,
    });
    console.log("  INV-7 holds: multisig sole member == native treasury PDA");
  }

  // ---- stage fund-buyer ----
  if (!stageDone("fund-buyer")) {
    console.log("\n[fund-buyer]");
    const sig = await sendTx(
      connection,
      [
        SystemProgram.transfer({
          fromPubkey: deployer.publicKey,
          toPubkey: buyer.publicKey,
          lamports: BUYER_FUNDING,
        }),
      ],
      [deployer],
      "fund-buyer",
    );
    record("fund-buyer", { sig, lamports: BUYER_FUNDING });
  }

  // ---- stage buy ----
  const buyerAta = getAssociatedTokenAddressSync(
    MINT,
    buyer.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  if (!stageDone("buy")) {
    console.log("\n[buy]");
    const online = new OnlinePumpSdk(connection);
    const offline = new PumpSdk();
    const global = await online.fetchGlobal();
    const buyState = await online.fetchBuyState(MINT, buyer.publicKey, TOKEN_2022_PROGRAM_ID);
    const buySol = new BN(BUY_LAMPORTS);
    const ixs = await offline.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint: MINT,
      user: buyer.publicKey,
      amount: getBuyTokenAmountFromSolAmount({
        global,
        feeConfig: null,
        mintSupply: null,
        bondingCurve: buyState.bondingCurve,
        amount: buySol,
        quoteMint: NATIVE_MINT,
      }),
      solAmount: buySol,
      slippage: 5,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    const sig = await sendTx(connection, ixs, [buyer], "buy");
    const bal = await connection.getTokenAccountBalance(buyerAta);
    record("buy", { sig, tokens: bal.value.amount });
    console.log(`  buyer holds ${bal.value.uiAmountString} tokens`);
  }

  // ---- stage voting-power ----
  const buyerTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    MINT,
    buyer.publicKey,
  );
  if (!stageDone("voting-power")) {
    console.log("\n[voting-power]");
    const tokens = BigInt(evidence.stages["buy"]!.tokens as string);
    if (useVsr) {
      // VSR path is exercised only if the probe unexpectedly passed.
      throw new Error("VSR voting-power path not wired for this run; probe said useVsr");
    }
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
      new BN(tokens.toString()),
    );
    // Deployed v3.1.4 requires the mint appended for Token-2022 transfers
    // ("Expected mint account is required for Token-2022 deposits and
    // withdrawals") — JS 0.3.28 predates this; append it manually.
    const patched = retargetTokenProgram(ixs);
    patched[patched.length - 1]!.keys.push({
      pubkey: MINT,
      isSigner: false,
      isWritable: false,
    });
    const sim = await simulate(connection, patched, buyer.publicKey, "deposit(token22)");
    if (sim) {
      finding(
        "CRITICAL (D-013 extension): plain governance deposits ALSO fail " +
          "for the Token-2022 community mint — no community voting path " +
          "exists on deployed programs for pump v2 mints.",
      );
      record("voting-power", { simError: sim.err, simLogs: sim.logs, verdict: "ABORT" });
      evidence.result = "PARTIAL (DAO stood up; community voting impossible on token22)";
      save();
      process.exit(1);
    }
    const sig = await sendTx(connection, patched, [buyer], "deposit");
    record("voting-power", { sig, deposited: tokens.toString(), tor: buyerTor.toBase58() });
  }

  // ---- stage proposal ----
  if (!stageDone("proposal")) {
    console.log("\n[proposal]");
    const vaultLamports = await connection.getBalance(SQUADS_VAULT);
    if (vaultLamports === 0) throw new Error("test vault is empty; nothing to sweep");
    const innerIx = SystemProgram.transfer({
      fromPubkey: SQUADS_VAULT,
      toPubkey: deployer.publicKey,
      lamports: vaultLamports,
    });
    const innerHash = computeInstructionSetHash([innerIx]);
    const txIndex = await fetchNextTransactionIndex(connection, MULTISIG);
    const wrapped = wrap([innerIx], {
      multisigPda: MULTISIG,
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
      "GATE1: sweep test vault via custody chain",
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

    // One ProposalTransaction per wrapped step (the adapter's CU split).
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
    const endsAt = votingAt + BASE_VOTING_TIME_S;
    const wait = endsAt + 10 - Math.floor(Date.now() / 1000);
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

  // ---- stage execute (INV-3: hold-up 0, INV-9: hash, INV-7: funds move) ----
  if (!stageDone("execute")) {
    console.log("\n[execute]");
    const vaultBefore = await connection.getBalance(SQUADS_VAULT);
    const deployerBefore = await connection.getBalance(deployer.publicKey);

    // INV-9 live: recompute the inner hash from the ON-CHAIN ProposalTransactions.
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
            keys: d.accounts.map((a: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }) => ({
              pubkey: a.pubkey,
              isSigner: a.isSigner,
              isWritable: a.isWritable,
            })),
            data: Buffer.from(d.data),
          }),
        );
      }
    }
    const txIndex = BigInt(evidence.stages["proposal"]!.squadsTransactionIndex as string);
    const recovered = unwrap(onChainWrapped, {
      multisigPda: MULTISIG,
      vaultIndex: 0,
      transactionIndex: txIndex,
      member: chain.nativeTreasury,
    });
    const onChainHash = computeInstructionSetHash(recovered);
    const artifactHash = evidence.stages["proposal"]!.innerInstructionSetHash as string;
    if (onChainHash !== artifactHash) {
      throw new Error(
        `INV-9 violated: on-chain hash ${onChainHash} != artifact ${artifactHash}`,
      );
    }
    console.log(`  INV-9 holds: on-chain instruction-set hash == artifact (${onChainHash.slice(0, 16)}...)`);

    const executeSigs: string[] = [];
    for (const [i, ptAddr] of ptAddrs.entries()) {
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
      const sim = await simulate(connection, ixs, buyer.publicKey, `execute-${i}`);
      if (sim) throw new Error(`execute-${i} simulation failed`);
      executeSigs.push(await sendTx(connection, ixs, [buyer], `execute-${i}`));
    }

    const vaultAfter = await connection.getBalance(SQUADS_VAULT);
    const deployerAfter = await connection.getBalance(deployer.publicKey);
    console.log(`  squads vault: ${vaultBefore} -> ${vaultAfter}`);
    console.log(`  deployer:     ${deployerBefore} -> ${deployerAfter}`);
    if (vaultAfter !== 0) throw new Error("vault not fully swept by the proposal");
    record("execute", {
      executeSigs,
      inv9OnChainHash: onChainHash,
      vaultBefore,
      vaultAfter,
      deployerBefore,
      deployerAfter,
    });
  }

  // ---- stage cleanup: relinquish, withdraw deposit, sell, consolidate ----
  if (!stageDone("cleanup")) {
    console.log("\n[cleanup]");
    const sigs: Record<string, string> = {};
    const voteRecord = await getVoteRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      proposal,
      buyerTor,
    );
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

    // This DAO was created with depositExemptProposalCount 0 (pre-D-015), so
    // the ~0.102 SOL proposal security deposit was charged; refund it.
    const refundIxs: TransactionInstruction[] = [];
    await withRefundProposalDeposit(
      refundIxs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      proposal,
      buyer.publicKey,
    );
    sigs["refund-proposal-deposit"] = await sendTx(
      connection,
      refundIxs,
      [buyer],
      "refund-proposal-deposit",
    );

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
    const patchedWithdraw = retargetTokenProgram(withdrawIxs);
    patchedWithdraw[patchedWithdraw.length - 1]!.keys.push({
      pubkey: MINT,
      isSigner: false,
      isWritable: false,
    });
    sigs["withdraw"] = await sendTx(
      connection,
      patchedWithdraw,
      [buyer],
      "withdraw-deposit",
    );

    record("cleanup", { sigs });
    console.log("  (sell-back + consolidation handled by the wallet-sweep step)");
  }

  evidence.result = "PASS";
  save();
  console.log("\nGATE 1 (partial, mainnet sovereign): PASS");
  console.log(`evidence: ${EVIDENCE}`);
}

main().catch((e) => {
  console.error(e);
  save();
  process.exit(1);
});
