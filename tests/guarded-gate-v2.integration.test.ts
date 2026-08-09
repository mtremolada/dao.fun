/**
 * R0 — gate v2 front door, end to end on REAL binaries (PLAN-UNIFIED-LAUNCH).
 *
 * The D-042 spike proved the mechanism with a Keypair standing in for the
 * gate. This suite replaces the stand-in with the PROGRAM: the gate
 * authority PDA (["gate-authority", realm]) owns the sole council token and
 * signs every governance CPI via invoke_signed against the deployed GovER5
 * v3.1.4 binary:
 *
 *   - bind_realm deposits the single council token (only the gate can sign
 *     for its PDA — the ceremony's one program-touch);
 *   - create_gated_proposal: ANY wallet proposes; the proposal is authored
 *     by the gate's council record with the COMMUNITY electorate;
 *   - insert_gated_transaction validates the exact bytes it inserts: a
 *     whitelisted transfer passes, an off-menu program is refused BEFORE
 *     any CPI (nothing off-menu ever exists inside a guarded proposal);
 *   - sign_off_gated_proposal opens voting; the community passes the
 *     proposal (vote -> finalize -> Succeeded);
 *   - the ceremony config still refuses DIRECT community creation at the
 *     u64::MAX sentinel — the front door is the only door.
 *
 * Instruction building DELEGATES to @daofun/sdk's gate module — this run
 * against the real binaries is simultaneously the SDK's proof (the
 * launchpad-harness pattern: suite and SDK cannot drift).
 *
 * Fixture: tests/fixtures/proposal_gate.so.gz — our cargo-build-sbf
 * artifact (D-029 toolchain; rebuild command in launchpad-harness.ts).
 * Run: pnpm test:integration
 */
import { beforeAll, describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  ComputeBudgetProgram,
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
  getProposalDepositAddress,
  getTokenOwnerRecordAddress,
  withCastVote,
  withCreateGovernance,
  withCreateProposal,
  withCreateRealm,
  withDepositGoverningTokens,
  withFinalizeVote,
} from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import {
  PROPOSAL_GATE_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  buildBindRealmIx,
  buildCreateGatedProposalIx,
  buildGateInitializeIx,
  buildInsertGatedTransactionIx,
  buildSignOffGatedProposalIx,
  gateAuthorityPda,
  proposalTransactionPda,
  tokenOwnerRecordPda,
  DEFAULT_GATE_WHITELIST,
  gatePda,
} from "../packages/sdk/src/gate";
import {
  BASE_VOTING_TIME_S,
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  VAULT_FUND,
  createDao,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";
import { buildGuardedProposeIxs } from "../packages/sdk/src/proposal";
import { SQUADS_V4_PROGRAM_ID } from "../packages/sdk/src/constants";
import * as multisig from "@sqds/multisig";

const GATE_PROGRAM_ID = PROPOSAL_GATE_PROGRAM_ID;
const U64_MAX = new BN("18446744073709551615");

describe("gate v2 — the guarded front door, program-signed on real binaries", () => {
  let ctx: ProgramTestContext;
  const whale = Keypair.generate();
  const proposer = Keypair.generate(); // a random wallet with no tokens at all
  const communityMint = Keypair.generate();
  const councilMint = Keypair.generate();
  let realm: PublicKey;
  let governance: PublicKey;
  let whaleTor: PublicKey;
  let gateAuthority: PublicKey;
  let gateTor: PublicKey;
  let cuNonce = 0;

  const cu = () =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + cuNonce++ });

  beforeAll(async () => {
    ctx = await startCtx([{ name: "proposal_gate", programId: GATE_PROGRAM_ID }]);
    const payer = ctx.payer;
    const rent = Number((await ctx.banksClient.getRent()).minimumBalance(BigInt(MINT_SIZE)));
    const whaleAta = getAssociatedTokenAddressSync(communityMint.publicKey, whale.publicKey);

    // The realm name seeds the PDAs; derive before creating anything.
    const realmName = "guarded-v2";
    // Gate PDAs hang off the realm.
    const realmSetup: TransactionInstruction[] = [];
    realm = await withCreateRealm(
      realmSetup,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      realmName,
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
    gateAuthority = gateAuthorityPda(realm);
    const gateAta = getAssociatedTokenAddressSync(councilMint.publicKey, gateAuthority, true);

    // Launch-shaped mints: full community supply to the whale; the ONE
    // council token straight into the gate authority's ATA; no authorities.
    await send(
      ctx,
      [
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: whale.publicKey, lamports: 5_000_000_000 }),
        SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: proposer.publicKey, lamports: 2_000_000_000 }),
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
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, gateAta, gateAuthority, councilMint.publicKey),
        createMintToInstruction(communityMint.publicKey, whaleAta, payer.publicKey, SUPPLY),
        createMintToInstruction(councilMint.publicKey, gateAta, payer.publicKey, 1),
        createSetAuthorityInstruction(communityMint.publicKey, payer.publicKey, AuthorityType.MintTokens, null),
        createSetAuthorityInstruction(councilMint.publicKey, payer.publicKey, AuthorityType.MintTokens, null),
      ],
      [communityMint, councilMint],
    );
    await send(ctx, [cu(), ...realmSetup], []);

    // Whale voting power.
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
      gateAuthority,
    );

    // The guarded config — the D-042 spike's exact shape.
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
      payer.publicKey,
    );
    await send(ctx, [cu(), ...governanceSetup], []);

    // Gate initialize (v2: mints pinned) with a system-program-only menu so
    // the off-menu refusal leg has something to refuse.
    await send(
      ctx,
      [
        buildGateInitializeIx({
          payer: payer.publicKey,
          realm,
          governance,
          communityMint: communityMint.publicKey,
          councilMint: councilMint.publicKey,
          whitelist: [SystemProgram.programId],
        }),
      ],
      [],
    );
  }, TEST_TIMEOUT);

  it(
    "bind_realm: the gate deposits its own council token (program-signed)",
    async () => {
      await send(
        ctx,
        [
          cu(),
          buildBindRealmIx({
            payer: ctx.payer.publicKey,
            realm,
            councilMint: councilMint.publicKey,
          }),
        ],
        [],
      );
      // TokenOwnerRecordV2: deposit amount u64 at offset 1+32+32+32 = 97.
      const tor = await ctx.banksClient.getAccount(gateTor);
      expect(tor).not.toBeNull();
      expect(Buffer.from(tor!.data).readBigUInt64LE(97)).toBe(1n);
    },
    TEST_TIMEOUT,
  );

  it(
    "any wallet proposes through the gate; off-menu inserts are refused; the community passes it",
    async () => {
      // -- create (proposer holds ZERO tokens; the gate's record authors) --
      const proposalSeed = Keypair.generate().publicKey;
      // The client-side deposit derivation must agree with the SDK's sync one.
      const created = buildCreateGatedProposalIx({
        proposer: proposer.publicKey,
        realm,
        governance,
        communityMint: communityMint.publicKey,
        councilMint: councilMint.publicKey,
        name: "guarded sweep",
        descriptionLink: "artifact-hash",
        proposalSeed,
      });
      const proposal = created.proposal;
      expect(
        (
          await getProposalDepositAddress(SPL_GOVERNANCE_PROGRAM_ID, proposal, proposer.publicKey)
        ).toBase58(),
      ).toBe(created.ix.keys[8]!.pubkey.toBase58());
      await send(ctx, [cu(), created.ix], [proposer]);
      expect((await readGov(ctx, proposal, Proposal)).state).toBe(ProposalState.Draft);

      // -- insert: whitelisted (system transfer) passes --
      const inner = SystemProgram.transfer({
        fromPubkey: governance,
        toPubkey: proposer.publicKey,
        lamports: 1,
      });
      const gatedInsert = (index: number, ixs: TransactionInstruction[]) =>
        buildInsertGatedTransactionIx({
          proposer: proposer.publicKey,
          realm,
          governance,
          councilMint: councilMint.publicKey,
          proposal,
          index,
          holdUpSeconds: 0,
          instructions: ixs,
        });
      await send(ctx, [cu(), gatedInsert(0, [inner]).ix], [proposer]);

      // -- insert: an off-menu program is refused BEFORE any CPI --
      const offMenu = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID, // not on the whitelist
        keys: [],
        data: Buffer.from([3]),
      });
      const logs = await sendExpectFail(ctx, [cu(), gatedInsert(1, [offMenu]).ix], [proposer]);
      expect(logs).toMatch(/OffMenuProgram|outside the gate whitelist/i);
      expect(
        await ctx.banksClient.getAccount(proposalTransactionPda(proposal, 0, 1)),
      ).toBeNull();

      // -- sign off -> Voting --
      await send(
        ctx,
        [
          cu(),
          buildSignOffGatedProposalIx({
            realm,
            governance,
            councilMint: councilMint.publicKey,
            proposal,
          }),
        ],
        [], // sign-off needs no payer — the gate PDA is the only signer, via CPI
      );
      expect((await readGov(ctx, proposal, Proposal)).state).toBe(ProposalState.Voting);

      // -- the community (not the council) votes it through --
      const vote: TransactionInstruction[] = [];
      await withCastVote(
        vote,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        governance,
        proposal,
        gateTor,
        whaleTor,
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

  it(
    "the ceremony config still refuses DIRECT community creation — the gate is the only door",
    async () => {
      const ixs: TransactionInstruction[] = [];
      await withCreateProposal(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        realm,
        governance,
        whaleTor,
        "direct",
        "",
        communityMint.publicKey,
        whale.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        whale.publicKey,
      );
      const logs = await sendExpectFail(ctx, [cu(), ...ixs], [whale]);
      expect(logs).toMatch(/voter weight threshold disabled/i);
    },
    TEST_TIMEOUT,
  );
});

describe("guarded CEREMONY — buildCreateDaoIxs('guarded') lands on real binaries", () => {
  it(
    "the production ceremony builds the front door, and the DAO governs through it",
    async () => {
      const ctx2 = await startCtx([
        { name: "proposal_gate", programId: GATE_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx2, "guarded");

      // The gate exists, bound to this realm's mints, in guarded mode with
      // the 8-program default menu.
      const gateInfo = await ctx2.banksClient.getAccount(gatePda(dao.realm));
      expect(gateInfo).not.toBeNull();
      const g = Buffer.from(gateInfo!.data);
      expect(new PublicKey(g.subarray(8, 40)).equals(dao.realm)).toBe(true);
      expect(new PublicKey(g.subarray(40, 72)).equals(dao.governance)).toBe(true);
      expect(new PublicKey(g.subarray(72, 104)).equals(dao.mint)).toBe(true);
      expect(new PublicKey(g.subarray(104, 136)).equals(dao.councilMint!)).toBe(true);
      expect(g[136]).toBe(0); // guarded
      expect(g.readUInt32LE(138)).toBe(DEFAULT_GATE_WHITELIST.length);

      // The gate's council record holds the ONE council token (bound by CPI).
      const authority = gateAuthorityPda(dao.realm);
      const torInfo = await ctx2.banksClient.getAccount(
        tokenOwnerRecordPda(dao.realm, dao.councilMint!, authority),
      );
      expect(Buffer.from(torInfo!.data).readBigUInt64LE(97)).toBe(1n);

      // The community CANNOT author directly on this production config...
      const direct: TransactionInstruction[] = [];
      await withCreateProposal(
        direct,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        dao.voterTor,
        "direct",
        "",
        dao.mint,
        dao.voter.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        dao.voter.publicKey,
      );
      const refusal = await sendExpectFail(ctx2, direct, [dao.voter]);
      expect(refusal).toMatch(/voter weight threshold disabled/i);

      // ...but ANYONE can author THROUGH the gate, and the community votes.
      const proposer2 = Keypair.generate();
      await send(
        ctx2,
        [
          SystemProgram.transfer({
            fromPubkey: ctx2.payer.publicKey,
            toPubkey: proposer2.publicKey,
            lamports: 1_000_000_000,
          }),
        ],
        [],
      );
      const seed = Keypair.generate().publicKey;
      const made = buildCreateGatedProposalIx({
        proposer: proposer2.publicKey,
        realm: dao.realm,
        governance: dao.governance,
        communityMint: dao.mint,
        councilMint: dao.councilMint!,
        name: "treasury grant",
        descriptionLink: "hash",
        proposalSeed: seed,
      });
      await send(ctx2, [made.ix], [proposer2]);
      const grant = SystemProgram.transfer({
        fromPubkey: dao.nativeTreasury,
        toPubkey: proposer2.publicKey,
        lamports: 1_000,
      });
      await send(
        ctx2,
        [
          buildInsertGatedTransactionIx({
            proposer: proposer2.publicKey,
            realm: dao.realm,
            governance: dao.governance,
            councilMint: dao.councilMint!,
            proposal: made.proposal,
            index: 0,
            holdUpSeconds: dao.params.holdUpSeconds,
            instructions: [grant],
          }).ix,
        ],
        [proposer2],
      );
      await send(
        ctx2,
        [
          buildSignOffGatedProposalIx({
            realm: dao.realm,
            governance: dao.governance,
            councilMint: dao.councilMint!,
            proposal: made.proposal,
          }),
        ],
        [],
      );
      const vote: TransactionInstruction[] = [];
      await withCastVote(
        vote,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        tokenOwnerRecordPda(dao.realm, dao.councilMint!, authority),
        dao.voterTor,
        dao.voter.publicKey,
        dao.mint,
        new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        }),
        ctx2.payer.publicKey,
      );
      await send(ctx2, vote, [dao.voter]);
      await warpSeconds(ctx2, BASE_VOTING_TIME_S + 10);
      const finalize: TransactionInstruction[] = [];
      await withFinalizeVote(
        finalize,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        tokenOwnerRecordPda(dao.realm, dao.councilMint!, authority),
        dao.mint,
      );
      await send(ctx2, finalize, []);
      expect((await readGov(ctx2, made.proposal, Proposal)).state).toBe(
        ProposalState.Succeeded,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "buildGuardedProposeIxs routes the PRODUCTION propose path through the gate",
    async () => {
      // buildProposeIxs is what every caller reaches for. On a guarded realm
      // it does not produce a weaker proposal — it produces a REJECTED
      // transaction, because the fork's u64::MAX sentinel refuses every
      // direct author (D-042). This is the variant that works, and it has to
      // keep the direct path's contract: same Squads wrapping, same INV-9
      // hash as the proposal's descriptionLink.
      const ctx3 = await startCtx([
        { name: "proposal_gate", programId: GATE_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx3, "guarded");
      const proposer = Keypair.generate();
      await send(
        ctx3,
        [
          SystemProgram.transfer({
            fromPubkey: ctx3.payer.publicKey,
            toPubkey: proposer.publicKey,
            lamports: 2_000_000_000,
          }),
        ],
        [],
      );

      const msAccount = await ctx3.banksClient.getAccount(dao.multisigPda);
      const [ms] = multisig.accounts.Multisig.fromAccountInfo({
        executable: false,
        owner: SQUADS_V4_PROGRAM_ID,
        lamports: Number(msAccount!.lamports),
        data: Buffer.from(msAccount!.data),
      });
      const recipient = Keypair.generate().publicKey;
      const inner = [
        SystemProgram.transfer({
          fromPubkey: dao.vaultPda,
          toPubkey: recipient,
          lamports: VAULT_FUND,
        }),
      ];

      const made = await buildGuardedProposeIxs({
        realm: dao.realm,
        governance: dao.governance,
        governingTokenMint: dao.mint,
        tokenOwnerRecord: dao.voterTor,
        governanceAuthority: proposer.publicKey,
        payer: proposer.publicKey,
        proposalIndex: 0,
        name: "guarded sweep via the production path",
        innerIxs: inner,
        wrapCtx: {
          multisigPda: dao.multisigPda,
          vaultIndex: 0,
          transactionIndex: BigInt(ms.transactionIndex.toString()) + 1n,
          member: dao.nativeTreasury,
        },
        holdUpSeconds: dao.params.holdUpSeconds,
        communityMint: dao.mint,
        councilMint: dao.councilMint!,
        proposalSeed: Keypair.generate().publicKey,
      });

      await send(ctx3, [...made.groups.create], [proposer], proposer);
      for (const group of made.groups.inserts) {
        await send(ctx3, [...group], [proposer], proposer);
      }
      await send(ctx3, [...made.groups.signOff], [proposer], proposer);

      // D-017 holds on the guarded path too: the descriptionLink IS the hash
      // of what will actually execute.
      const onChain = await readGov(ctx3, made.proposal, Proposal);
      expect(onChain.descriptionLink).toBe(made.innerInstructionSetHash);
      expect(onChain.state).toBe(ProposalState.Voting);

      // The electorate is untouched: the COMMUNITY votes it through. But the
      // proposal's OWNER is the gate's council record, not the voter's — the
      // gate authored it. Callers that finalize or execute a guarded proposal
      // must pass that record, or governance refuses with "Invalid Proposal
      // Owner". Worth pinning: it is the one place the guarded path's
      // account list genuinely differs from the direct one.
      const gateOwnerRecord = tokenOwnerRecordPda(
        dao.realm,
        dao.councilMint!,
        gateAuthorityPda(dao.realm),
      );
      const voteIxs: TransactionInstruction[] = [];
      await withCastVote(
        voteIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        gateOwnerRecord,
        dao.voterTor,
        dao.voter.publicKey,
        dao.mint,
        new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        }),
        ctx3.payer.publicKey,
      );
      await send(ctx3, voteIxs, [dao.voter]);

      await warpSeconds(ctx3, BASE_VOTING_TIME_S + 10);
      const finalIxs: TransactionInstruction[] = [];
      await withFinalizeVote(
        finalIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        gateOwnerRecord,
        dao.mint,
      );
      await send(ctx3, finalIxs, []);
      expect((await readGov(ctx3, made.proposal, Proposal)).state).toBe(
        ProposalState.Succeeded,
      );
    },
    TEST_TIMEOUT,
  );
});
