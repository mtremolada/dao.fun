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
 * Fixture: tests/fixtures/proposal_gate.so.gz — our cargo-build-sbf
 * artifact (D-029 toolchain; rebuild command in launchpad-harness.ts).
 * Run: pnpm test:integration
 */
import { createHash } from "node:crypto";
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
  getGoverningTokenHoldingAddress,
  getProposalDepositAddress,
  getRealmConfigAddress,
  getTokenOwnerRecordAddress,
  withCastVote,
  withCreateGovernance,
  withCreateProposal,
  withCreateRealm,
  withDepositGoverningTokens,
  withFinalizeVote,
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

const GATE_PROGRAM_ID = new PublicKey("3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg");
const U64_MAX = new BN("18446744073709551615");

const disc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const borshStr = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};
const AM = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});

/** Borsh InstructionData — identical to what the gate re-serializes. */
function serializeInstructionSet(ixs: TransactionInstruction[]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(ixs.length);
  parts.push(count);
  for (const ix of ixs) {
    parts.push(ix.programId.toBuffer());
    const metaCount = Buffer.alloc(4);
    metaCount.writeUInt32LE(ix.keys.length);
    parts.push(metaCount);
    for (const k of ix.keys) {
      parts.push(
        k.pubkey.toBuffer(),
        Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]),
      );
    }
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(ix.data.length);
    parts.push(dataLen, Buffer.from(ix.data));
  }
  return Buffer.concat(parts);
}

describe("gate v2 — the guarded front door, program-signed on real binaries", () => {
  let ctx: ProgramTestContext;
  const whale = Keypair.generate();
  const proposer = Keypair.generate(); // a random wallet with no tokens at all
  const communityMint = Keypair.generate();
  const councilMint = Keypair.generate();
  let realm: PublicKey;
  let governance: PublicKey;
  let whaleTor: PublicKey;
  let gatePk: PublicKey;
  let gateAuthority: PublicKey;
  let gateTor: PublicKey;
  let realmConfig: PublicKey;
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
    gateAuthority = PublicKey.findProgramAddressSync(
      [Buffer.from("gate-authority"), realm.toBuffer()],
      GATE_PROGRAM_ID,
    )[0];
    gatePk = PublicKey.findProgramAddressSync(
      [Buffer.from("gate"), realm.toBuffer()],
      GATE_PROGRAM_ID,
    )[0];
    const gateAta = getAssociatedTokenAddressSync(councilMint.publicKey, gateAuthority, true);
    realmConfig = await getRealmConfigAddress(SPL_GOVERNANCE_PROGRAM_ID, realm);

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

    // Gate initialize (v2: mints pinned) with a system-program-only menu.
    const whitelist = [SystemProgram.programId];
    const vec = Buffer.alloc(4);
    vec.writeUInt32LE(whitelist.length);
    await send(
      ctx,
      [
        new TransactionInstruction({
          programId: GATE_PROGRAM_ID,
          keys: [
            AM(gatePk, false, true),
            AM(payer.publicKey, true, true),
            AM(SystemProgram.programId, false, false),
          ],
          data: Buffer.concat([
            disc("initialize"),
            realm.toBuffer(),
            governance.toBuffer(),
            communityMint.publicKey.toBuffer(),
            councilMint.publicKey.toBuffer(),
            Buffer.from([0]), // guarded
            vec,
            ...whitelist.map((p) => p.toBuffer()),
          ]),
        }),
      ],
      [],
    );
  }, TEST_TIMEOUT);

  it(
    "bind_realm: the gate deposits its own council token (program-signed)",
    async () => {
      const holding = await getGoverningTokenHoldingAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        realm,
        councilMint.publicKey,
      );
      const gateAta = getAssociatedTokenAddressSync(councilMint.publicKey, gateAuthority, true);
      await send(
        ctx,
        [
          cu(),
          new TransactionInstruction({
            programId: GATE_PROGRAM_ID,
            keys: [
              AM(gatePk, false, false),
              AM(gateAuthority, false, false),
              AM(realm, false, false),
              AM(holding, false, true),
              AM(gateAta, false, true),
              AM(gateTor, false, true),
              AM(realmConfig, false, true),
              AM(ctx.payer.publicKey, true, true),
              AM(SystemProgram.programId, false, false),
              AM(TOKEN_PROGRAM_ID, false, false),
              AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
            ],
            data: Buffer.from(disc("bind_realm")),
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
      const [proposal] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("governance"),
          governance.toBuffer(),
          communityMint.publicKey.toBuffer(),
          proposalSeed.toBuffer(),
        ],
        SPL_GOVERNANCE_PROGRAM_ID,
      );
      const proposalDeposit = await getProposalDepositAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        proposal,
        proposer.publicKey,
      );
      const createKeys = [
        AM(gatePk, false, false),
        AM(gateAuthority, false, false),
        AM(realm, false, false),
        AM(proposal, false, true),
        AM(governance, false, true),
        AM(gateTor, false, true),
        AM(communityMint.publicKey, false, false),
        AM(realmConfig, false, false),
        AM(proposalDeposit, false, true),
        AM(proposer.publicKey, true, true),
        AM(SystemProgram.programId, false, false),
        AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
      ];
      await send(
        ctx,
        [
          cu(),
          new TransactionInstruction({
            programId: GATE_PROGRAM_ID,
            keys: createKeys,
            data: Buffer.concat([
              disc("create_gated_proposal"),
              borshStr("guarded sweep"),
              borshStr("artifact-hash"),
              proposalSeed.toBuffer(),
            ]),
          }),
        ],
        [proposer],
      );
      expect((await readGov(ctx, proposal, Proposal)).state).toBe(ProposalState.Draft);

      // -- insert: whitelisted (system transfer) passes --
      const inner = SystemProgram.transfer({
        fromPubkey: governance,
        toPubkey: proposer.publicKey,
        lamports: 1,
      });
      const ptPda = (index: number) =>
        PublicKey.findProgramAddressSync(
          [
            Buffer.from("governance"),
            proposal.toBuffer(),
            Buffer.from([0]),
            Buffer.from(new Uint8Array(new Uint16Array([index]).buffer)),
          ],
          SPL_GOVERNANCE_PROGRAM_ID,
        )[0];
      const insertKeys = (pt: PublicKey) => [
        AM(gatePk, false, false),
        AM(gateAuthority, false, false),
        AM(governance, false, false),
        AM(proposal, false, true),
        AM(gateTor, false, false),
        AM(pt, false, true),
        AM(proposer.publicKey, true, true),
        AM(SystemProgram.programId, false, false),
        AM(new PublicKey("SysvarRent111111111111111111111111111111111"), false, false),
        AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
      ];
      const insertData = (index: number, ixs: TransactionInstruction[]) =>
        Buffer.concat([
          disc("insert_gated_transaction"),
          Buffer.from([0]), // option 0
          Buffer.from(new Uint8Array(new Uint16Array([index]).buffer)),
          Buffer.from(new Uint8Array(new Uint32Array([0]).buffer)), // hold-up
          serializeInstructionSet(ixs),
        ]);
      await send(
        ctx,
        [
          cu(),
          new TransactionInstruction({
            programId: GATE_PROGRAM_ID,
            keys: insertKeys(ptPda(0)),
            data: insertData(0, [inner]),
          }),
        ],
        [proposer],
      );

      // -- insert: an off-menu program is refused BEFORE any CPI --
      const offMenu = new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID, // not on the whitelist
        keys: [],
        data: Buffer.from([3]),
      });
      const logs = await sendExpectFail(
        ctx,
        [
          cu(),
          new TransactionInstruction({
            programId: GATE_PROGRAM_ID,
            keys: insertKeys(ptPda(1)),
            data: insertData(1, [offMenu]),
          }),
        ],
        [proposer],
      );
      expect(logs).toMatch(/OffMenuProgram|outside the gate whitelist/i);
      expect(await ctx.banksClient.getAccount(ptPda(1))).toBeNull();

      // -- sign off -> Voting --
      await send(
        ctx,
        [
          cu(),
          new TransactionInstruction({
            programId: GATE_PROGRAM_ID,
            keys: [
              AM(gatePk, false, false),
              AM(gateAuthority, false, false),
              AM(realm, false, true),
              AM(governance, false, true),
              AM(proposal, false, true),
              AM(gateTor, false, false),
              AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
            ],
            data: Buffer.from(disc("sign_off_gated_proposal")),
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
