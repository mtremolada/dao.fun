/**
 * D-032 Option A verification spike — Guarded mode's structural enforcement,
 * proven against the DEPLOYED governance fork (GovER5…, v3.1.4, the exact
 * binary in tests/fixtures/spl_governance.so).
 *
 * The design under test ("gate the front door"): the proposal-gate program
 * holds the realm's ONLY council token, and the governance config sets
 * min_community_weight_to_create_proposal to u64::MAX. Community supply is
 * fixed at launch (mint authority nulled), so u64::MAX is unreachable by
 * construction — no holder, whale, or delegate can EVER author a proposal;
 * the gate's council record is the single front door, and its create CPI
 * runs the D-030 validation engine before anything exists to vote on.
 *
 * What must be true on THIS fork for Option A to be committable:
 *  1. create_proposal at the u64::MAX community threshold is refused even
 *     for a record holding the ENTIRE community supply (strongest attacker);
 *  2. the delegate path is equally closed (weight binds the record, not the
 *     signer);
 *  3. a council record CAN author a proposal whose electorate is the
 *     COMMUNITY mint (gate proposes, community votes — the Guarded UX);
 *  4. the community passes that proposal normally (vote → finalize →
 *     Succeeded);
 *  5. council exclusivity is structural: supply 1, mint authority null, and
 *     a freshly-created zero-weight council record cannot author.
 *
 * A Keypair stands in for the gate PDA: invoke_signed gives a PDA the same
 * signer semantics the runtime checks here.
 *
 * Run: pnpm test:integration
 */
import { beforeAll, describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
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
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  GovernanceConfig,
  MintMaxVoteWeightSource,
  Proposal,
  ProposalState,
  Vote,
  VoteChoice,
  VoteKind,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  VoteType,
  getTokenOwnerRecordAddress,
  withCastVote,
  withCreateGovernance,
  withCreateProposal,
  withCreateRealm,
  withCreateTokenOwnerRecord,
  withDepositGoverningTokens,
  withFinalizeVote,
  withSetGovernanceDelegate,
  withSignOffProposal,
} from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import {
  BASE_VOTING_TIME_S,
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const U64_MAX = new BN("18446744073709551615");

describe("guarded gate spike — front-door exclusivity on the deployed fork", () => {
  let ctx: ProgramTestContext;
  const whale = Keypair.generate();
  const mallory = Keypair.generate(); // delegate / zero-weight attacker
  const gate = Keypair.generate(); // stands in for the gate PDA (invoke_signed)
  const communityMint = Keypair.generate();
  const councilMint = Keypair.generate();
  let realm: PublicKey;
  let governance: PublicKey;
  let whaleTor: PublicKey;
  let gateTor: PublicKey;
  let cuNonce = 0;

  const cu = () =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + cuNonce++ });

  beforeAll(async () => {
    ctx = await startCtx();
    const payer = ctx.payer;
    const rent = Number((await ctx.banksClient.getRent()).minimumBalance(BigInt(MINT_SIZE)));
    const whaleAta = getAssociatedTokenAddressSync(communityMint.publicKey, whale.publicKey);
    const gateAta = getAssociatedTokenAddressSync(councilMint.publicKey, gate.publicKey);

    // Mints exactly like a launch: full community supply to the whale, ONE
    // council token to the gate, then no mint authority exists on either.
    await send(
      ctx,
      [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: whale.publicKey, lamports: 5_000_000_000 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: mallory.publicKey, lamports: 1_000_000_000 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: gate.publicKey, lamports: 1_000_000_000 }),
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: communityMint.publicKey,
          lamports: rent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(communityMint.publicKey, 6, payer.publicKey, null),
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: councilMint.publicKey,
          lamports: rent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(councilMint.publicKey, 0, payer.publicKey, null),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, whaleAta, whale.publicKey, communityMint.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, gateAta, gate.publicKey, councilMint.publicKey),
        createMintToInstruction(communityMint.publicKey, whaleAta, payer.publicKey, SUPPLY),
        createMintToInstruction(councilMint.publicKey, gateAta, payer.publicKey, 1),
        createSetAuthorityInstruction(communityMint.publicKey, payer.publicKey, AuthorityType.MintTokens, null),
        createSetAuthorityInstruction(councilMint.publicKey, payer.publicKey, AuthorityType.MintTokens, null),
      ],
      [communityMint, councilMint],
    );

    // Realm with both mints; liquid community (no addin — deposit == weight,
    // the D-013 fallback), membership council — mirroring production.
    const realmSetup: TransactionInstruction[] = [];
    realm = await withCreateRealm(
      realmSetup,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      "guarded-spike",
      payer.publicKey,
      communityMint.publicKey,
      payer.publicKey,
      councilMint.publicKey,
      MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
      new BN(1),
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
    await send(ctx, [cu(), ...realmSetup], []);

    // Deposits: the whale's ENTIRE supply (max attainable community weight),
    // the gate's single council token.
    const depositWhale: TransactionInstruction[] = [];
    await withDepositGoverningTokens(
      depositWhale,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      realm,
      whaleAta,
      communityMint.publicKey,
      whale.publicKey,
      whale.publicKey,
      payer.publicKey,
      new BN(SUPPLY.toString()),
    );
    await send(ctx, depositWhale, [whale]);
    const depositGate: TransactionInstruction[] = [];
    await withDepositGoverningTokens(
      depositGate,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      realm,
      gateAta,
      councilMint.publicKey,
      gate.publicKey,
      gate.publicKey,
      payer.publicKey,
      new BN(1),
    );
    await send(ctx, depositGate, [gate]);
    whaleTor = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      realm,
      communityMint.publicKey,
      whale.publicKey,
    );
    gateTor = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      realm,
      councilMint.publicKey,
      gate.publicKey,
    );

    // The Guarded config: community creation at the unreachable sentinel,
    // council creation at 1 (the gate's whole weight); everything else is
    // the production matrix shape.
    const disabled = new VoteThreshold({ type: VoteThresholdType.Disabled });
    const config = new GovernanceConfig({
      communityVoteThreshold: new VoteThreshold({ type: VoteThresholdType.YesVotePercentage, value: 60 }),
      minCommunityTokensToCreateProposal: U64_MAX,
      minInstructionHoldUpTime: 0,
      baseVotingTime: BASE_VOTING_TIME_S,
      communityVoteTipping: VoteTipping.Disabled,
      minCouncilTokensToCreateProposal: new BN(1),
      councilVoteThreshold: disabled,
      councilVetoVoteThreshold: disabled,
      communityVetoVoteThreshold: disabled,
      councilVoteTipping: VoteTipping.Strict,
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    });
    const governanceSetup: TransactionInstruction[] = [];
    governance = await withCreateGovernance(
      governanceSetup,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      realm,
      communityMint.publicKey,
      config,
      whaleTor,
      payer.publicKey,
      payer.publicKey, // createAuthority == realm authority during the ceremony
    );
    await send(ctx, [cu(), ...governanceSetup], []);
  }, TEST_TIMEOUT);

  async function createProposalIxs(
    tokenOwnerRecord: PublicKey,
    authority: PublicKey,
    payer: PublicKey,
    index: number,
  ): Promise<{ proposal: PublicKey; ixs: TransactionInstruction[] }> {
    const ixs: TransactionInstruction[] = [];
    const proposal = await withCreateProposal(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      realm,
      governance,
      tokenOwnerRecord,
      `spike #${index}`,
      "",
      communityMint.publicKey, // the ELECTORATE is always the community
      authority,
      index,
      VoteType.SINGLE_CHOICE,
      ["Approve"],
      true,
      payer,
    );
    return { proposal, ixs };
  }

  it(
    "refuses community proposal creation at the sentinel — even holding the ENTIRE supply",
    async () => {
      const { ixs } = await createProposalIxs(whaleTor, whale.publicKey, whale.publicKey, 0);
      const logs = await sendExpectFail(ctx, [cu(), ...ixs], [whale]);
      // The fork treats u64::MAX as an EXPLICIT disabled sentinel — better
      // than an unreachable threshold: creation is off, not merely far away.
      expect(logs).toMatch(/voter weight threshold disabled/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses the delegate path too — weight binds the record, not the signer",
    async () => {
      const delegateIxs: TransactionInstruction[] = [];
      await withSetGovernanceDelegate(
        delegateIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        communityMint.publicKey,
        whale.publicKey,
        whale.publicKey,
        mallory.publicKey,
      );
      await send(ctx, delegateIxs, [whale]);

      const { ixs } = await createProposalIxs(whaleTor, mallory.publicKey, mallory.publicKey, 0);
      const logs = await sendExpectFail(ctx, [cu(), ...ixs], [mallory]);
      expect(logs).toMatch(/voter weight threshold disabled/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "a zero-weight council record cannot author either — exclusivity is weight, not identity",
    async () => {
      const torIxs: TransactionInstruction[] = [];
      await withCreateTokenOwnerRecord(
        torIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        mallory.publicKey,
        councilMint.publicKey,
        mallory.publicKey,
      );
      await send(ctx, torIxs, [mallory]);
      const malloryTor = await getTokenOwnerRecordAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        realm,
        councilMint.publicKey,
        mallory.publicKey,
      );
      const { ixs } = await createProposalIxs(malloryTor, mallory.publicKey, mallory.publicKey, 0);
      const logs = await sendExpectFail(ctx, [cu(), ...ixs], [mallory]);
      expect(logs).toMatch(/enough.*tokens|NotEnoughTokens|0x21/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "the gate's sole council record authors a proposal the COMMUNITY then passes",
    async () => {
      // Council supply is structurally closed: 1 token, no mint authority.
      const mintInfo = await ctx.banksClient.getAccount(councilMint.publicKey);
      const mintData = Buffer.from(mintInfo!.data);
      expect(mintData.readUInt32LE(0)).toBe(0); // COption::None mint authority
      expect(mintData.readBigUInt64LE(36)).toBe(1n); // supply

      // 3. The front door: gate authors for the community electorate.
      const { proposal, ixs } = await createProposalIxs(gateTor, gate.publicKey, gate.publicKey, 0);
      await send(ctx, [cu(), ...ixs], [gate]);

      const signOff: TransactionInstruction[] = [];
      withSignOffProposal(
        signOff,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        governance,
        proposal,
        gate.publicKey,
        undefined,
        gateTor,
      );
      await send(ctx, signOff, [gate]);
      expect((await readGov(ctx, proposal, Proposal)).state).toBe(ProposalState.Voting);

      // 4. Community votes it through — creation was gated, voting is not.
      const vote: TransactionInstruction[] = [];
      await withCastVote(
        vote,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        governance,
        proposal,
        gateTor, // proposal owner record
        whaleTor, // voter
        whale.publicKey,
        communityMint.publicKey,
        new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        }),
        ctx.payer.publicKey,
      );
      await send(ctx, [cu(), ...vote], [whale]);

      await warpSeconds(ctx, BASE_VOTING_TIME_S + 10);
      const finalize: TransactionInstruction[] = [];
      await withFinalizeVote(
        finalize,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        governance,
        proposal,
        gateTor,
        communityMint.publicKey,
      );
      await send(ctx, [cu(), ...finalize], []);
      expect((await readGov(ctx, proposal, Proposal)).state).toBe(ProposalState.Succeeded);
    },
    TEST_TIMEOUT,
  );
});
