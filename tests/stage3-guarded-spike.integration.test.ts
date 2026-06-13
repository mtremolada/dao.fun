/**
 * Option A verification spike (D-032 -> D-033): can proposal creation be
 * made TRULY EXCLUSIVE to the proposal-gate on the deployed GovER5 fork?
 *
 * Everything here runs against the REAL mainnet spl-governance binary in
 * bankrun. The questions this suite answers empirically (the "UNVERIFIED
 * RISK" that gated the operator decision):
 *
 *  1. minCommunityTokensToCreateProposal = u64::MAX refuses creation even
 *     for a whale who deposited the ENTIRE community supply — and for the
 *     whale's governance delegate (no whale/delegate loophole).
 *  2. A COUNCIL TokenOwnerRecord can author a proposal whose voting
 *     population is the COMMUNITY mint (the gate's creation seat), the
 *     community can pass it, and it executes.
 *  3. With the gate seat holding H+1 council tokens and
 *     minCouncilTokensToCreateProposal = H+1, no human council member can
 *     author (1 < H+1), even though every human keeps the veto.
 *  4. Council veto (with the threshold percent adjusted for the gate
 *     seat's share of council supply) still vetoes a gate-authored
 *     community proposal.
 *  5. Realm authority can be parked on a NON-SIGNING PDA via
 *     SetRealmAuthority(SetUnchecked); afterwards realm-authority-gated
 *     operations are refused for everyone else.
 *
 * The "gate seat" is a plain keypair here — PDA signing via CPI is proven
 * by the gate program suite (stage3-guarded.integration.test.ts); this
 * spike pins the FORK SEMANTICS the design rests on.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  GovernanceConfig,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  MintMaxVoteWeightSource,
  Proposal,
  ProposalState,
  SetRealmAuthorityAction,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  VoteType,
  createInstructionData,
  getProposalTransactionAddress,
  getTokenOwnerRecordAddress,
  withCreateGovernance,
  withCreateNativeTreasury,
  withCreateProposal,
  withCreateRealm,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withInsertTransaction,
  withSetGovernanceDelegate,
  withSetRealmAuthority,
  withSignOffProposal,
} from "@solana/spl-governance";
import {
  Vote,
  VoteChoice,
  VoteKind,
  withCastVote,
} from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import {
  BASE_VOTING_TIME_S,
  SUPPLY,
  TEST_TIMEOUT,
  balance,
  mintRent,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";

const PROGRAM_VERSION = 3;
const U64_MAX = new BN("18446744073709551615");
/** H humans on the veto council; the gate seat holds H+1 (exclusivity). */
const HUMANS = 2;
const GATE_SEAT_TOKENS = HUMANS + 1;
/**
 * Council veto threshold, adjusted for the gate seat's share of council
 * supply (2H+1): we want 2-of-2 humans to veto, 1-of-2 not to. Human
 * weight 2 of max 5 = 40%; one human = 20%. 30% sits unambiguously
 * between, independent of the program's >=-vs-> comparison.
 */
const VETO_PERCENT_ONCHAIN = 30;

interface SpikeRealm {
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
  communityMint: PublicKey;
  councilMint: PublicKey;
  whale: Keypair;
  whaleTor: PublicKey;
  humans: Keypair[];
  humanTors: PublicKey[];
  gateSeat: Keypair;
  gateSeatTor: PublicKey;
}

async function fund(ctx: ProgramTestContext, to: PublicKey, lamports: number) {
  await send(
    ctx,
    [
      SystemProgram.transfer({
        fromPubkey: ctx.payer.publicKey,
        toPubkey: to,
        lamports,
      }),
    ],
    [],
  );
}

async function createMint(
  ctx: ProgramTestContext,
  decimals: number,
): Promise<Keypair> {
  const mint = Keypair.generate();
  await send(
    ctx,
    [
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: Number(await mintRent(ctx)),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        decimals,
        ctx.payer.publicKey,
        null,
      ),
    ],
    [mint],
  );
  return mint;
}

async function mintTo(
  ctx: ProgramTestContext,
  mint: PublicKey,
  owner: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  await send(
    ctx,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.payer.publicKey,
        ata,
        owner,
        mint,
      ),
      createMintToInstruction(mint, ata, ctx.payer.publicKey, amount),
    ],
    [],
  );
  return ata;
}

async function deposit(
  ctx: ProgramTestContext,
  realm: PublicKey,
  mint: PublicKey,
  owner: Keypair,
  sourceAta: PublicKey,
  amount: bigint,
): Promise<PublicKey> {
  const ixs: TransactionInstruction[] = [];
  await withDepositGoverningTokens(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    sourceAta,
    mint,
    owner.publicKey,
    owner.publicKey,
    ctx.payer.publicKey,
    new BN(amount.toString()),
  );
  await send(ctx, ixs, [owner]);
  return getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    mint,
    owner.publicKey,
  );
}

/**
 * Hand-rolled guarded-flavor realm: community creation DISABLED
 * (u64::MAX), council creation reachable only by the gate seat (H+1).
 * Mirrors buildCreateDaoIxs conventions everywhere else.
 */
async function createGuardedFlavorRealm(
  ctx: ProgramTestContext,
): Promise<SpikeRealm> {
  const payer = ctx.payer;
  const whale = Keypair.generate();
  const humans = Array.from({ length: HUMANS }, () => Keypair.generate());
  const gateSeat = Keypair.generate();
  for (const k of [whale, gateSeat, ...humans]) {
    await fund(ctx, k.publicKey, 1_000_000_000);
  }

  // Community mint: ENTIRE supply to the whale (worst case for Q1).
  const communityMint = await createMint(ctx, 6);
  const whaleAta = await mintTo(
    ctx,
    communityMint.publicKey,
    whale.publicKey,
    SUPPLY,
  );
  // Council mint: 1 per human, H+1 to the gate seat, then NO authority.
  const councilMint = await createMint(ctx, 0);
  const humanAtas: PublicKey[] = [];
  for (const h of humans) {
    humanAtas.push(await mintTo(ctx, councilMint.publicKey, h.publicKey, 1n));
  }
  const gateSeatAta = await mintTo(
    ctx,
    councilMint.publicKey,
    gateSeat.publicKey,
    BigInt(GATE_SEAT_TOKENS),
  );
  await send(
    ctx,
    [
      createSetAuthorityInstruction(
        communityMint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
      createSetAuthorityInstruction(
        councilMint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
    ],
    [],
  );

  // Realm: community creation weight floors at u64::MAX everywhere.
  const realmSetup: TransactionInstruction[] = [];
  const realm = await withCreateRealm(
    realmSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    `guarded-spike-${communityMint.publicKey.toBase58().slice(0, 12)}`,
    payer.publicKey,
    communityMint.publicKey,
    payer.publicKey,
    councilMint.publicKey,
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
    U64_MAX, // minCommunityWeightToCreateGovernance: also disabled
    new GoverningTokenConfigAccountArgs({
      voterWeightAddin: undefined,
      maxVoterWeightAddin: undefined,
      tokenType: GoverningTokenType.Liquid,
    }),
    new GoverningTokenConfigAccountArgs({
      voterWeightAddin: undefined,
      maxVoterWeightAddin: undefined,
      tokenType: GoverningTokenType.Membership,
    }),
  );
  await send(ctx, realmSetup, []);

  const disabled = new VoteThreshold({ type: VoteThresholdType.Disabled });
  const config = new GovernanceConfig({
    communityVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: 25,
    }),
    minCommunityTokensToCreateProposal: U64_MAX, // the front door, welded
    minInstructionHoldUpTime: 0,
    baseVotingTime: BASE_VOTING_TIME_S,
    communityVoteTipping: VoteTipping.Disabled,
    minCouncilTokensToCreateProposal: new BN(GATE_SEAT_TOKENS),
    councilVoteThreshold: disabled,
    councilVetoVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: VETO_PERCENT_ONCHAIN,
    }),
    communityVetoVoteThreshold: disabled,
    councilVoteTipping: VoteTipping.Strict,
    votingCoolOffTime: 0,
    depositExemptProposalCount: 10,
  });

  const governanceSetup: TransactionInstruction[] = [];
  const payerTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    communityMint.publicKey,
    payer.publicKey,
  );
  const governance = await withCreateGovernance(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    communityMint.publicKey,
    config,
    payerTor,
    payer.publicKey,
    payer.publicKey,
  );
  const nativeTreasury = await withCreateNativeTreasury(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    governance,
    payer.publicKey,
  );
  await send(ctx, governanceSetup, []);
  await fund(ctx, nativeTreasury, 10_000_000);

  // Deposits: whale ALL of the community supply; every human their 1
  // council token (Membership: never withdrawable); gate seat its H+1.
  const whaleTor = await deposit(
    ctx,
    realm,
    communityMint.publicKey,
    whale,
    whaleAta,
    SUPPLY,
  );
  const humanTors: PublicKey[] = [];
  for (const [i, h] of humans.entries()) {
    humanTors.push(
      await deposit(ctx, realm, councilMint.publicKey, h, humanAtas[i]!, 1n),
    );
  }
  const gateSeatTor = await deposit(
    ctx,
    realm,
    councilMint.publicKey,
    gateSeat,
    gateSeatAta,
    BigInt(GATE_SEAT_TOKENS),
  );

  return {
    realm,
    governance,
    nativeTreasury,
    communityMint: communityMint.publicKey,
    councilMint: councilMint.publicKey,
    whale,
    whaleTor,
    humans,
    humanTors,
    gateSeat,
    gateSeatTor,
  };
}

/**
 * Cast a community yes or a council veto on a gate-seat-owned proposal.
 * The veto's governing mint is the COUNCIL mint (D-011 pattern).
 */
async function castVote(
  ctx: ProgramTestContext,
  r: SpikeRealm,
  proposal: PublicKey,
  voter: Keypair,
  voterTor: PublicKey,
  kind: "yes" | "veto",
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    r.realm,
    r.governance,
    proposal,
    r.gateSeatTor, // proposal owner's record
    voterTor,
    voter.publicKey,
    kind === "yes" ? r.communityMint : r.councilMint,
    kind === "yes"
      ? new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        })
      : new Vote({
          voteType: VoteKind.Veto,
          approveChoices: undefined,
          deny: false,
          veto: true,
        }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [voter]);
}

/** withCreateProposal under a given owner record/authority; community-voted. */
async function buildCreate(
  r: SpikeRealm,
  tor: PublicKey,
  authority: PublicKey,
  payer: PublicKey,
  name: string,
): Promise<{ ixs: TransactionInstruction[]; proposal: PublicKey }> {
  const ixs: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    r.realm,
    r.governance,
    tor,
    name,
    "spike",
    r.communityMint, // the VOTING population is the community
    authority,
    undefined,
    VoteType.SINGLE_CHOICE,
    ["Approve"],
    true,
    payer,
  );
  return { ixs, proposal };
}

describe("Option A spike: creation exclusivity on the deployed governance fork", () => {
  it(
    "welds the community front door shut, seats creation with the gate, keeps the human veto, parks realm authority on a PDA",
    async () => {
      const ctx = await startCtx();
      const r = await createGuardedFlavorRealm(ctx);

      // ===== Q1: the whale (100% of supply DEPOSITED) cannot create =====
      const whaleAttempt = await buildCreate(
        r,
        r.whaleTor,
        r.whale.publicKey,
        r.whale.publicKey,
        "whale tries the front door",
      );
      const whaleErr = await sendExpectFail(ctx, whaleAttempt.ixs, [r.whale]);
      expect(whaleErr).toMatch(/custom program error/i);

      // ===== Q1b: neither can the whale's governance delegate =====
      const delegate = Keypair.generate();
      await fund(ctx, delegate.publicKey, 1_000_000_000);
      const delegateIxs: TransactionInstruction[] = [];
      await withSetGovernanceDelegate(
        delegateIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.realm,
        r.communityMint,
        r.whale.publicKey,
        r.whale.publicKey,
        delegate.publicKey,
      );
      await send(ctx, delegateIxs, [r.whale]);
      const delegateAttempt = await buildCreate(
        r,
        r.whaleTor,
        delegate.publicKey,
        delegate.publicKey,
        "delegate tries the front door",
      );
      const delegateErr = await sendExpectFail(ctx, delegateAttempt.ixs, [
        delegate,
      ]);
      expect(delegateErr).toMatch(/custom program error/i);
      // both refusals are the same weight check, not e.g. a signer error
      expect(delegateErr.match(/custom program error: (0x[0-9a-f]+)/i)?.[1]).toBe(
        whaleErr.match(/custom program error: (0x[0-9a-f]+)/i)?.[1],
      );

      // ===== Q3: a human council member (1 token) cannot create =====
      const humanAttempt = await buildCreate(
        r,
        r.humanTors[0]!,
        r.humans[0]!.publicKey,
        r.humans[0]!.publicKey,
        "human council member tries",
      );
      expect(
        await sendExpectFail(ctx, humanAttempt.ixs, [r.humans[0]!]),
      ).toMatch(/custom program error/i);

      // ===== Q2: the gate seat (H+1 council tokens) CAN author a
      // community-voted proposal; the community passes it; it executes ===
      const recipient = Keypair.generate().publicKey;
      const create = await buildCreate(
        r,
        r.gateSeatTor,
        r.gateSeat.publicKey,
        r.gateSeat.publicKey,
        "gate-authored, community-voted",
      );
      const inner = SystemProgram.transfer({
        fromPubkey: r.nativeTreasury,
        toPubkey: recipient,
        lamports: 1_000_000,
      });
      const insertIxs: TransactionInstruction[] = [];
      await withInsertTransaction(
        insertIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.governance,
        create.proposal,
        r.gateSeatTor,
        r.gateSeat.publicKey,
        0,
        0,
        0,
        [createInstructionData(inner)],
        r.gateSeat.publicKey,
      );
      const signOffIxs: TransactionInstruction[] = [];
      withSignOffProposal(
        signOffIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.realm,
        r.governance,
        create.proposal,
        r.gateSeat.publicKey,
        undefined,
        r.gateSeatTor,
      );
      await send(
        ctx,
        [...create.ixs, ...insertIxs, ...signOffIxs],
        [r.gateSeat],
        r.gateSeat,
      );
      expect((await readGov(ctx, create.proposal, Proposal)).state).toBe(
        ProposalState.Voting,
      );

      // community yes from the whale (proposal owner record = gate seat)
      await castVote(ctx, r, create.proposal, r.whale, r.whaleTor, "yes");
      await warpSeconds(ctx, BASE_VOTING_TIME_S + 10);
      const finalized = await finalize(ctx, r, create.proposal);
      expect(finalized).toBe(ProposalState.Succeeded);

      const before = await balance(ctx, recipient);
      const execIxs: TransactionInstruction[] = [];
      await withExecuteTransaction(
        execIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.governance,
        create.proposal,
        await getProposalTransactionAddress(
          SPL_GOVERNANCE_PROGRAM_ID,
          PROGRAM_VERSION,
          create.proposal,
          0,
          0,
        ),
        [createInstructionData(inner)],
      );
      await send(ctx, execIxs, []);
      expect((await balance(ctx, recipient)) - before).toBe(1_000_000);

      // ===== Q4: the human council still vetoes a gate-authored proposal =====
      const veto = await buildCreate(
        r,
        r.gateSeatTor,
        r.gateSeat.publicKey,
        r.gateSeat.publicKey,
        "gate-authored, vetoed by humans",
      );
      const vetoInsert: TransactionInstruction[] = [];
      await withInsertTransaction(
        vetoInsert,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.governance,
        veto.proposal,
        r.gateSeatTor,
        r.gateSeat.publicKey,
        0,
        0,
        0,
        [createInstructionData(inner)],
        r.gateSeat.publicKey,
      );
      const vetoSignOff: TransactionInstruction[] = [];
      withSignOffProposal(
        vetoSignOff,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.realm,
        r.governance,
        veto.proposal,
        r.gateSeat.publicKey,
        undefined,
        r.gateSeatTor,
      );
      await send(
        ctx,
        [...veto.ixs, ...vetoInsert, ...vetoSignOff],
        [r.gateSeat],
        r.gateSeat,
      );
      // one human veto (20% of council supply) does NOT tip it...
      await castVote(
        ctx,
        r,
        veto.proposal,
        r.humans[0]!,
        r.humanTors[0]!,
        "veto",
      );
      expect((await readGov(ctx, veto.proposal, Proposal)).state).toBe(
        ProposalState.Voting,
      );
      // ...the second (40% > 30% threshold) does — Strict council tipping
      await castVote(
        ctx,
        r,
        veto.proposal,
        r.humans[1]!,
        r.humanTors[1]!,
        "veto",
      );
      expect((await readGov(ctx, veto.proposal, Proposal)).state).toBe(
        ProposalState.Vetoed,
      );

      // ===== Q5: realm authority parks on a non-signing PDA =====
      const gatePda = PublicKey.findProgramAddressSync(
        [Buffer.from("gate"), r.realm.toBuffer()],
        new PublicKey("3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg"),
      )[0];
      const setAuthIxs: TransactionInstruction[] = [];
      withSetRealmAuthority(
        setAuthIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.realm,
        ctx.payer.publicKey, // ceremony payer still holds it in this spike
        gatePda,
        SetRealmAuthorityAction.SetUnchecked,
      );
      await send(ctx, setAuthIxs, []);
      // the OLD authority can no longer move it...
      const reclaim: TransactionInstruction[] = [];
      withSetRealmAuthority(
        reclaim,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        r.realm,
        ctx.payer.publicKey,
        ctx.payer.publicKey,
        SetRealmAuthorityAction.SetUnchecked,
      );
      expect(await sendExpectFail(ctx, reclaim, [])).toMatch(
        /custom program error/i,
      );
    },
    TEST_TIMEOUT,
  );
});

async function finalize(
  ctx: ProgramTestContext,
  r: SpikeRealm,
  proposal: PublicKey,
): Promise<ProposalState> {
  const { withFinalizeVote } = await import("@solana/spl-governance");
  const ixs: TransactionInstruction[] = [];
  await withFinalizeVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    r.realm,
    r.governance,
    proposal,
    r.gateSeatTor,
    r.communityMint,
  );
  await send(ctx, ixs, []);
  return (await readGov(ctx, proposal, Proposal)).state;
}
