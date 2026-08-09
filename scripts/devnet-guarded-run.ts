/**
 * GATE L5 — the guarded front door, live on devnet.
 *
 * Runs the PRODUCTION ceremony (`buildCreateDaoIxs("guarded")`) against real
 * accounts on a real cluster, then proves the two properties guarded mode
 * exists for:
 *
 *   1. a holder of the ENTIRE community supply CANNOT author a proposal —
 *      `min_community_weight_to_create_proposal = u64::MAX` is an explicit
 *      "disabled" sentinel, not a large number (D-042);
 *   2. anyone CAN author through the gate, and the electorate is the
 *      community mint.
 *
 * WHAT THIS ADDS over bankrun, and what it does not. Devnet runs
 * spl-governance **3.1.2**, not the mainnet **3.1.4** fork
 * (tests/devnet-governance-parity pins the difference and shows both behave
 * the same on the property above), so this is not a substitute for the
 * mainnet evidence — it is a real-cluster check that the deployed gate
 * binary, real rent, real transaction sizes and the production builders all
 * work together outside a simulator.
 *
 * Finalize/execute are NOT attempted by default: production params use a
 * 3-day voting window and a 72-hour hold-up, and a live cluster's clock cannot
 * be warped. The run stops at a cast vote and reports the state honestly;
 * `devnet-guarded-advance.ts` finishes it days later.
 *
 * `--fast` runs the SAME ceremony against a governance whose window and
 * hold-up are minutes rather than days, and drives the lifecycle to the end:
 * finalize, an execution the hold-up must REFUSE, then a real execution whose
 * effect is checked on chain. Only two numbers change, and they are governance
 * CONFIG, not gate logic — every account, builder, CPI and the deployed gate
 * binary are the production ones. The hold-up is short but NON-ZERO on
 * purpose: zero would skip the check instead of proving it.
 *
 *   pnpm tsx scripts/devnet-guarded-run.ts [--fast]
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  AuthorityType,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Proposal,
  ProposalState,
  Vote,
  VoteChoice,
  VoteKind,
  VoteType,
  GovernanceAccountParser,
  getTokenOwnerRecordAddress,
  withCastVote,
  withCreateProposal,
  withDepositGoverningTokens,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import { buildCreateTreasuryIx, fetchProgramConfigTreasury } from "../packages/sdk/src/treasury";
import { deriveGovernanceChainFromMint } from "../packages/sdk/src/pda";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import {
  DEFAULT_GATE_WHITELIST,
  buildCreateGatedProposalIx,
  buildInsertGatedTransactionIx,
  buildSignOffGatedProposalIx,
  gateAuthorityPda,
  gatePda,
  tokenOwnerRecordPda,
} from "../packages/sdk/src/gate";
import {
  advanceProposal,
  buildExecuteTransactions,
  readProposalContext,
} from "./lib/gov-advance";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_VERSION = 3;
const SUPPLY = 200_000_000_000n;

/** `--fast`: a clock we can outwait, so finalize and execute run in this run. */
const FAST = process.argv.includes("--fast");
/**
 * Short enough to be usable, long enough to be a real window.
 *
 * The fast value is ONE HOUR because that is the floor `withCreateGovernance`
 * enforces ("baseVotingTime should be at least 1 hour"). Shorter windows are
 * reachable only by hand-building the instruction, which would mean the run no
 * longer exercises the production builder — and the builder being the
 * production one is the entire point of running this live. An hour of waiting
 * is the cheaper price.
 */
const BASE_VOTING_TIME_S = FAST ? 3600 : 3 * 86400;
/**
 * The instruction hold-up. Kept identical to the governance minimum so the
 * "executable at" arithmetic has one source rather than two that can disagree,
 * and NON-ZERO in fast mode so the refusal below is a real check.
 */
const HOLD_UP_S = FAST ? 120 : null;
/** Funds the DAO treasury so the executed transfer moves real lamports. */
const TREASURY_FUNDING = 20_000_000;
/** What the proposal's instruction moves — the observable effect of execute. */
const EXECUTED_TRANSFER = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const payer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

const cu = (units = 400_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });

async function send(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
  extra: Keypair[] = [],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [signer, ...extra], {
    commitment: "confirmed",
  });
}

/** Send and REQUIRE failure; returns the error text for matching. */
async function sendExpectFail(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
  extra: Keypair[] = [],
): Promise<string> {
  try {
    await send(connection, signer, ixs, extra);
    return "";
  } catch (e) {
    const err = e as Error & { logs?: string[] };
    return [err.message, ...(err.logs ?? [])].join("\n");
  }
}

/**
 * Return whatever is left in the run's throwaway wallets.
 *
 * The deployer pays the fee so each wallet can send its ENTIRE balance rather
 * than having to keep a fee back — the leftovers are unreachable the moment
 * this process exits, so leaving any behind is leaving it on the floor.
 * Best-effort: a failed sweep is worth a warning, never a failed run.
 */
async function sweepBack(
  connection: Connection,
  signer: Keypair,
  wallets: { name: string; key: Keypair }[],
): Promise<void> {
  let total = 0;
  for (const w of wallets) {
    const lamports = await connection.getBalance(w.key.publicKey);
    if (lamports === 0) continue;
    try {
      await send(
        connection,
        signer,
        [
          cu(),
          SystemProgram.transfer({
            fromPubkey: w.key.publicKey,
            toPubkey: signer.publicKey,
            lamports,
          }),
        ],
        [w.key],
      );
      total += lamports;
    } catch (e) {
      console.log(`  sweep ${w.name} failed (${(e as Error).message.split("\n")[0]})`);
    }
  }
  if (total > 0) console.log(`\nswept back ${total / 1e9} SOL from throwaway wallets`);
}

/**
 * `--fast` only: the two legs a production-params run cannot reach.
 *
 * Finalize is what converts a cast vote into a Succeeded proposal, and execute
 * is where governance actually spends the treasury. Between them sits the
 * hold-up — the window that exists so a DAO can see what is about to happen
 * and leave. A hold-up that is merely CONFIGURED and not ENFORCED would look
 * identical on a passing run, so this attempts an execution inside the window
 * and requires it to be refused.
 */
async function driveToCompletion(
  connection: Connection,
  signer: Keypair,
  proposal: PublicKey,
  treasury: PublicKey,
): Promise<void> {
  console.log("\n--fast: driving the lifecycle to the end —");

  // 1. Wait out the voting window. Vote tipping is Disabled by design (a full
  //    exit window, always), so the window elapsing is what makes finalize
  //    possible — there is no early tip to shortcut it.
  let announced = Infinity;
  for (;;) {
    const ctx = await readProposalContext(connection, proposal);
    const left = ctx.votingEndsAt - Math.floor(Date.now() / 1000);
    if (left <= 0) break;
    if (announced - left >= 300 || announced === Infinity) {
      console.log(`  voting window: ${Math.ceil(left / 60)}min left`);
      announced = left;
    }
    await sleep(Math.min(left + 2, 60) * 1000);
  }

  const finalized = await advanceProposal(connection, signer, proposal);
  check(
    finalized.outcome.step === "finalized",
    "the voting window elapsing makes FINALIZE possible",
    finalized.outcome.step,
  );
  if (finalized.outcome.step === "finalized") {
    console.log(`  finalize     ${finalized.outcome.signature}`);
    check(
      finalized.outcome.state === ProposalState.Succeeded,
      "finalize moves the proposal to SUCCEEDED",
      ProposalState[finalized.outcome.state],
    );
  }

  // 2. The hold-up must REFUSE an execution, not merely be configured.
  const ctx = await readProposalContext(connection, proposal);
  const pending = await buildExecuteTransactions(connection, ctx);
  check(pending.length === 1, "the proposal carries its one transaction", `${pending.length}`);
  const early = await sendExpectFail(connection, signer, [cu(), ...pending[0]!.ixs]);
  check(
    early !== "" && /hold.?up/i.test(early),
    "execution INSIDE the hold-up window is refused",
    early === "" ? "IT EXECUTED" : early.split("\n").find((l) => /hold.?up/i.test(l))?.trim() ?? early.split("\n")[0]!,
  );

  // 3. Wait it out, then execute for real and check the EFFECT, not the
  //    return code: a proposal that "completes" without moving the lamports
  //    it promised would pass every state check and still be broken.
  for (;;) {
    const left = ctx.executableAt - Math.floor(Date.now() / 1000);
    if (left <= 0) break;
    console.log(`  hold-up: ${left}s left`);
    await sleep(Math.min(left + 2, 30) * 1000);
  }

  const before = await connection.getBalance(treasury);
  const executed = await advanceProposal(connection, signer, proposal);
  check(
    executed.outcome.step === "executed",
    "the hold-up elapsing makes EXECUTE possible",
    executed.outcome.step,
  );
  if (executed.outcome.step === "executed") {
    for (const [i, sig] of executed.outcome.signatures.entries()) {
      console.log(`  execute[${i}]  ${sig}`);
    }
    check(
      executed.outcome.state === ProposalState.Completed,
      "the proposal is COMPLETED",
      ProposalState[executed.outcome.state],
    );
  }
  const after = await connection.getBalance(treasury);
  check(
    before - after === EXECUTED_TRANSFER,
    "the DAO treasury actually paid out what the proposal said",
    `${before} -> ${after} (${before - after} lamports)`,
  );
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const signer = payer();
  console.log(`payer ${signer.publicKey.toBase58()}`);
  console.log(`start ${(await connection.getBalance(signer.publicKey)) / 1e9} SOL\n`);

  // ---- community mint: full supply to one holder, then authority nulled ----
  const voter = Keypair.generate();
  const mint = Keypair.generate();
  const councilMintKp = Keypair.generate();
  const createKey = Keypair.generate();
  const mintRent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const voterAta = getAssociatedTokenAddressSync(mint.publicKey, voter.publicKey);

  console.log(`community mint ${mint.publicKey.toBase58()}`);
  await send(
    connection,
    signer,
    [
      cu(),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: voter.publicKey,
        lamports: 60_000_000,
      }),
      SystemProgram.createAccount({
        fromPubkey: signer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: mintRent,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, 6, signer.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        voterAta,
        voter.publicKey,
        mint.publicKey,
      ),
      createMintToInstruction(mint.publicKey, voterAta, signer.publicKey, SUPPLY),
      createSetAuthorityInstruction(
        mint.publicKey,
        signer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
    ],
    [mint],
  );

  // ---- Squads treasury, with the treasury address READ FROM CHAIN ----
  // The two clusters name different treasuries in the Squads ProgramConfig;
  // hardcoding mainnet's is refused here with 0x177e.
  const chain = deriveGovernanceChainFromMint(mint.publicKey);
  const programConfigTreasury = await fetchProgramConfigTreasury(connection);
  console.log(`squads treasury (from chain) ${programConfigTreasury.toBase58()}`);
  const treasury = buildCreateTreasuryIx({
    payer: signer.publicKey,
    predictedNativeTreasury: chain.nativeTreasury,
    createKey: createKey.publicKey,
    programConfigTreasury,
  });
  await send(connection, signer, [cu(), treasury.ix], [createKey]);

  // ---- the production guarded ceremony ----
  const resolved = resolveGovernanceParams({
    mode: "guarded",
    tier: "micro",
    communitySupply: SUPPLY,
  });
  const params =
    HOLD_UP_S === null ? resolved : { ...resolved, holdUpSeconds: HOLD_UP_S };
  const dao = await buildCreateDaoIxs({
    mint: mint.publicKey,
    payer: signer.publicKey,
    mode: "guarded",
    params,
    council: {
      mint: councilMintKp.publicKey,
      members: [], // the gate authority is derived as the sole member
      vetoThresholdPercent: 0,
      mintRentLamports: BigInt(mintRent),
    },
    baseVotingTimeSeconds: BASE_VOTING_TIME_S,
    communityVoterWeightAddin: null,
  });
  check(dao.realm.equals(chain.realm), "realm matches the advance-derived address");

  console.log("\nceremony —");
  console.log(`  council      ${await send(connection, signer, [cu(600_000), ...dao.groups.council], [councilMintKp])}`);
  console.log(`  realmSetup   ${await send(connection, signer, [cu(600_000), ...dao.groups.realmSetup], [])}`);
  console.log(`  governance   ${await send(connection, signer, [cu(600_000), ...dao.groups.governanceSetup], [])}`);
  console.log(`  realm        ${dao.realm.toBase58()}`);
  console.log(`  governance   ${dao.governance.toBase58()}`);
  console.log(`  treasury     ${dao.nativeTreasury.toBase58()}`);

  if (FAST) {
    // The native treasury is created rent-exempt and nothing more. Executing a
    // transfer out of it would drop it below the rent floor and fail on the
    // System program, so the effect we are trying to observe would be masked
    // by an unrelated failure. Fund it first.
    await send(connection, signer, [
      cu(),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: dao.nativeTreasury,
        lamports: TREASURY_FUNDING,
      }),
    ]);
  }

  // ---- the gate exists and holds the ONE council token ----
  const gateInfo = await connection.getAccountInfo(gatePda(dao.realm));
  check(gateInfo !== null, "the gate account exists");
  if (gateInfo) {
    const g = gateInfo.data;
    check(new PublicKey(g.subarray(8, 40)).equals(dao.realm), "gate is bound to this realm");
    check(new PublicKey(g.subarray(72, 104)).equals(mint.publicKey), "gate names the community mint");
    check(g[136] === 0, "gate is in GUARDED mode");
    check(
      g.readUInt32LE(138) === DEFAULT_GATE_WHITELIST.length,
      "gate carries the full default menu",
      `${g.readUInt32LE(138)} programs`,
    );
  }
  const authority = gateAuthorityPda(dao.realm);
  const gateTor = tokenOwnerRecordPda(dao.realm, councilMintKp.publicKey, authority);
  const torInfo = await connection.getAccountInfo(gateTor);
  check(
    torInfo !== null && torInfo.data.readBigUInt64LE(97) === 1n,
    "the gate's council record holds exactly ONE council token",
    torInfo ? `${torInfo.data.readBigUInt64LE(97)}` : "missing",
  );

  // ---- deposit the whole supply, so the attacker below is maximal ----
  const deposit: TransactionInstruction[] = [];
  await withDepositGoverningTokens(
    deposit,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    voterAta,
    mint.publicKey,
    voter.publicKey,
    voter.publicKey,
    signer.publicKey,
    new BN(SUPPLY.toString()),
  );
  await send(connection, signer, [cu(), ...deposit], [voter]);
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    mint.publicKey,
    voter.publicKey,
  );

  // ---- 1. the whale is REFUSED ----
  const direct: TransactionInstruction[] = [];
  await withCreateProposal(
    direct,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    voterTor,
    "direct",
    "",
    mint.publicKey,
    voter.publicKey,
    undefined,
    VoteType.SINGLE_CHOICE,
    ["Approve"],
    true,
    voter.publicKey,
  );
  const refusal = await sendExpectFail(connection, signer, [cu(), ...direct], [voter]);
  check(
    /voter weight threshold disabled/i.test(refusal),
    "a holder of the ENTIRE supply cannot author directly",
    refusal ? refusal.split("\n").find((l) => /threshold disabled/i.test(l))?.trim() ?? "refused" : "IT SUCCEEDED",
  );

  // ---- 2. anyone may author THROUGH the gate ----
  const proposer = Keypair.generate();
  await send(connection, signer, [
    cu(),
    SystemProgram.transfer({
      fromPubkey: signer.publicKey,
      toPubkey: proposer.publicKey,
      lamports: 60_000_000,
    }),
  ]);
  const made = buildCreateGatedProposalIx({
    proposer: proposer.publicKey,
    realm: dao.realm,
    governance: dao.governance,
    communityMint: mint.publicKey,
    councilMint: councilMintKp.publicKey,
    name: "devnet guarded grant",
    descriptionLink: "hash",
    proposalSeed: Keypair.generate().publicKey,
  });
  console.log(`\ngated propose  ${await send(connection, signer, [cu(), made.ix], [proposer])}`);
  console.log(`  proposal     ${made.proposal.toBase58()}`);

  console.log(
    `gated insert   ${await send(
      connection,
      signer,
      [
        cu(),
        buildInsertGatedTransactionIx({
          proposer: proposer.publicKey,
          realm: dao.realm,
          governance: dao.governance,
          councilMint: councilMintKp.publicKey,
          proposal: made.proposal,
          index: 0,
          holdUpSeconds: params.holdUpSeconds,
          instructions: [
            SystemProgram.transfer({
              fromPubkey: dao.nativeTreasury,
              toPubkey: proposer.publicKey,
              lamports: EXECUTED_TRANSFER,
            }),
          ],
        }).ix,
      ],
      [proposer],
    )}`,
  );
  console.log(
    `gated signoff  ${await send(connection, signer, [
      cu(),
      buildSignOffGatedProposalIx({
        realm: dao.realm,
        governance: dao.governance,
        councilMint: councilMintKp.publicKey,
        proposal: made.proposal,
      }),
    ])}`,
  );

  // ---- the community votes on it ----
  const vote: TransactionInstruction[] = [];
  await withCastVote(
    vote,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    made.proposal,
    gateTor,
    voterTor,
    voter.publicKey,
    mint.publicKey,
    new Vote({
      voteType: VoteKind.Approve,
      approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
      deny: undefined,
      veto: undefined,
    }),
    signer.publicKey,
  );
  console.log(`community vote ${await send(connection, signer, [cu(), ...vote], [voter])}`);

  const proposalInfo = await connection.getAccountInfo(made.proposal);
  const parsed = GovernanceAccountParser(Proposal)(made.proposal, proposalInfo!);
  const state = parsed.account.state;
  check(
    state === ProposalState.Voting || state === ProposalState.Succeeded,
    "the proposal is live with the COMMUNITY as its electorate",
    ProposalState[state],
  );
  if (!FAST) {
    console.log(
      `\nproposal state ${ProposalState[state]}` +
        (state === ProposalState.Voting
          ? ` — finalize needs the ${BASE_VOTING_TIME_S / 86400}-day window to elapse; a live cluster's clock cannot be warped, so this run stops here.`
          : ""),
    );
  } else {
    await driveToCompletion(connection, signer, made.proposal, dao.nativeTreasury);
  }

  // ---- give the throwaway wallets' SOL back ----
  // `voter` and `proposer` are generated per run and their keys never leave
  // this process, so anything left in them at exit is stranded FOREVER. At
  // 0.06 SOL each that is 0.12 SOL burned per run, which on a faucet-limited
  // cluster is the difference between being able to run this again and not.
  await sweepBack(connection, signer, [
    { name: "voter", key: voter },
    { name: "proposer", key: proposer },
  ]);

  console.log(
    `\nend ${(await connection.getBalance(signer.publicKey)) / 1e9} SOL — ` +
      (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
