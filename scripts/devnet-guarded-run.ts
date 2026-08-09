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
 * Finalize/execute are NOT attempted: production params use a 3-day voting
 * window and a 72-hour hold-up, and a live cluster's clock cannot be warped.
 * The run stops at a cast vote and reports the state honestly.
 *
 *   pnpm tsx scripts/devnet-guarded-run.ts
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

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_VERSION = 3;
const SUPPLY = 200_000_000_000n;
/** Short enough to be usable, long enough to be a real window. */
const BASE_VOTING_TIME_S = 3 * 86400;

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
  const params = resolveGovernanceParams({
    mode: "guarded",
    tier: "micro",
    communitySupply: SUPPLY,
  });
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
              lamports: 1_000,
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
  console.log(
    `\nproposal state ${ProposalState[state]}` +
      (state === ProposalState.Voting
        ? ` — finalize needs the ${BASE_VOTING_TIME_S / 86400}-day window to elapse; a live cluster's clock cannot be warped, so this run stops here.`
        : ""),
  );

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
