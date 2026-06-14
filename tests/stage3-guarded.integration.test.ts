/**
 * Guarded mode END TO END (Option A, spec 6.9/12.2, D-033) on the REAL
 * deployed binaries: the SDK ceremony builds a guarded DAO whose realm
 * authority and exclusive proposal-creation seat live with the gate PDA,
 * and the gate program CPIs the deployed spl-governance fork for the
 * whole proposal lifecycle. Proven here:
 *
 *  - ceremony shape: gate PDA holds realm authority; the gate's council
 *    TOR holds H+1 of the 2H+1 council tokens; the community front door
 *    is welded (u64::MAX) — the full-supply voter and the human council
 *    members are all refused at direct create_proposal;
 *  - the gate front door: a requester below the holdings threshold is
 *    refused; one above it authors a community-voted proposal through
 *    the gate (PDA-signed CreateProposal CPI);
 *  - insert-time validation ON THE FORWARDED BYTES: off-menu direct leg
 *    refused, off-menu program smuggled INSIDE the Squads vault message
 *    refused, any governance-program leg refused while guarded (the
 *    config stays immutable even by a winning vote), and nobody can
 *    bypass the gate with a direct InsertTransaction (the gate PDA
 *    cannot countersign);
 *  - menu proposal executes faithfully: custody-chain sweep, vault delta
 *    exact after vote + hold-up;
 *  - the human council veto survives the gate seat's supply dilution
 *    (one of two humans is not enough, the second tips to Vetoed);
 *  - requester-gating: only the original requester may insert/sign-off/
 *    cancel; cancel releases the draft;
 *  - the voted EXIT: ratchet leg (gate program, governance-signed)
 *    executes -> mode council; release_realm_authority (refused while
 *    guarded) hands the realm to its governance; arbitrary inserts now
 *    pass the gate; a voted SetGovernanceConfig restores direct
 *    creation — the realm converges on a standard MVP council DAO.
 *
 * Fixture: tests/fixtures/proposal_gate.so.gz — rebuild with
 *   cd programs && cargo-build-sbf --manifest-path proposal-gate/Cargo.toml
 *   && gzip -c target/deploy/proposal_gate.so > ../tests/fixtures/proposal_gate.so.gz
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import {
  Governance,
  Proposal,
  ProposalState,
  Realm,
  VoteType,
  createSetGovernanceConfig,
  withCreateProposal,
  withInsertTransaction,
  createInstructionData,
} from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  castCouncilVeto,
  createDao,
  executeIxsFor,
  finalizeAfterVotingWindow,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
  type Dao,
  type MadeProposal,
} from "./helpers/bankrun-harness";
import {
  GATE_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  buildGateCancelIx,
  buildGateInsertTransactionIx,
  buildGateProposeIxs,
  buildRatchetIx,
  buildReleaseRealmAuthorityIx,
  deriveGate,
  deriveGateTor,
  type GateRealmRefs,
  type GateProposeResult,
} from "../packages/sdk/src/gate";
import { wrap } from "../packages/sdk/src/execution-adapter";
import { SQUADS_V4_PROGRAM_ID } from "../packages/sdk/src/constants";
import BN from "bn.js";

const PROGRAM_VERSION = 3;

function refsOf(dao: Dao): GateRealmRefs {
  return {
    realm: dao.realm,
    governance: dao.governance,
    communityMint: dao.mint,
    councilMint: dao.councilMint!,
  };
}

async function nextSquadsTxIndex(
  ctx: ProgramTestContext,
  dao: Dao,
): Promise<bigint> {
  const msAccount = await ctx.banksClient.getAccount(dao.multisigPda);
  const [ms] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msAccount!.lamports),
    data: Buffer.from(msAccount!.data),
  });
  return BigInt(ms.transactionIndex.toString()) + 1n;
}

/** Author + insert + sign-off through the gate (requester = the voter). */
async function gatePropose(
  ctx: ProgramTestContext,
  dao: Dao,
  inner: TransactionInstruction[],
  label: string,
  directIxs?: TransactionInstruction[],
): Promise<GateProposeResult> {
  const made = await buildGateProposeIxs({
    refs: refsOf(dao),
    requester: dao.voter.publicKey,
    name: label,
    innerIxs: inner,
    ...(directIxs ? { directIxs } : {}),
    wrapCtx: {
      multisigPda: dao.multisigPda,
      vaultIndex: 0,
      transactionIndex: await nextSquadsTxIndex(ctx, dao),
      member: dao.nativeTreasury,
    },
    holdUpSeconds: dao.params.holdUpSeconds,
  });
  await send(ctx, made.groups.create, [dao.voter], dao.voter);
  for (const group of made.groups.inserts) {
    await send(ctx, group, [dao.voter], dao.voter);
  }
  await send(ctx, made.groups.signOff, [dao.voter], dao.voter);
  return made;
}

function asMade(made: GateProposeResult): MadeProposal {
  return {
    proposal: made.proposal,
    wrapped: made.wrapped,
    ptAddrs: made.ptAddrs,
    innerHash: made.innerInstructionSetHash,
    recipient: PublicKey.default,
  };
}

async function passAndExecute(
  ctx: ProgramTestContext,
  dao: Dao,
  made: GateProposeResult,
  gateTor: PublicKey,
) {
  await castCommunityYes(ctx, dao, made.proposal, gateTor);
  expect(
    await finalizeAfterVotingWindow(ctx, dao, made.proposal, gateTor),
  ).toBe(ProposalState.Succeeded);
  await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
  for (let i = 0; i < made.ptAddrs.length; i++) {
    await send(ctx, await executeIxsFor(dao, asMade(made), i), []);
  }
}

describe("Stage 3 Guarded mode end-to-end: gate front door on the deployed binaries", () => {
  it(
    "authors exclusively through the gate, validates forwarded bytes, keeps the human veto, and exits by vote",
    async () => {
      const ctx = await startCtx([
        { name: "proposal_gate", programId: GATE_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx, "guarded");
      const gate = deriveGate(dao.realm);
      const gateTor = deriveGateTor(dao.realm, dao.councilMint!);
      expect(dao.gate?.toBase58()).toBe(gate.toBase58());

      // ===== ceremony shape =====
      const realm = await readGov(ctx, dao.realm, Realm);
      expect(realm.authority?.toBase58()).toBe(gate.toBase58());
      // the gate seat: H+1 = 3 council tokens deposited in the gate's TOR
      const gateTorInfo = await ctx.banksClient.getAccount(gateTor);
      expect(gateTorInfo).not.toBeNull();

      // ===== the front door is welded for EVERYONE but the gate =====
      // the voter (98% of supply deposited) cannot create directly...
      const directAttempt: TransactionInstruction[] = [];
      await withCreateProposal(
        directAttempt,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        dao.voterTor,
        "direct attempt",
        "x",
        dao.mint,
        dao.voter.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        dao.voter.publicKey,
      );
      expect(await sendExpectFail(ctx, directAttempt, [dao.voter])).toMatch(
        /custom program error/i,
      );
      // ...and neither can a human council member (1 < H+1)
      const councilAttempt: TransactionInstruction[] = [];
      await withCreateProposal(
        councilAttempt,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        dao.councilTor!,
        "council attempt",
        "x",
        dao.mint,
        dao.councilMember.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        dao.councilMember.publicKey,
      );
      expect(
        await sendExpectFail(ctx, councilAttempt, [dao.councilMember]),
      ).toMatch(/custom program error/i);

      // ===== gate front door: threshold gating =====
      const pauper = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: pauper.publicKey,
            lamports: 1_000_000_000,
          }),
        ],
        [],
      );
      const pauperTry = await buildGateProposeIxs({
        refs: refsOf(dao),
        requester: pauper.publicKey,
        // their (nonexistent) ATA — the gate refuses before parsing
        name: "pauper",
        innerIxs: [
          SystemProgram.transfer({
            fromPubkey: dao.vaultPda,
            toPubkey: pauper.publicKey,
            lamports: 1,
          }),
        ],
        wrapCtx: {
          multisigPda: dao.multisigPda,
          vaultIndex: 0,
          transactionIndex: await nextSquadsTxIndex(ctx, dao),
          member: dao.nativeTreasury,
        },
        holdUpSeconds: dao.params.holdUpSeconds,
      });
      expect(
        await sendExpectFail(ctx, pauperTry.groups.create, [pauper]),
      ).toMatch(/RequesterBelowThreshold|community proposal threshold/i);

      // ===== a menu proposal (vault sweep) goes through the gate =====
      const recipient = Keypair.generate().publicKey;
      const sweep = await gatePropose(
        ctx,
        dao,
        [
          SystemProgram.transfer({
            fromPubkey: dao.vaultPda,
            toPubkey: recipient,
            lamports: VAULT_FUND,
          }),
        ],
        "sweep through the gate",
      );
      expect(sweep.ptAddrs.length).toBeGreaterThanOrEqual(4);
      const onChain = await readGov(ctx, sweep.proposal, Proposal);
      expect(onChain.state).toBe(ProposalState.Voting);
      // D-017 parity: descriptionLink IS the inner-set hash
      expect(onChain.descriptionLink).toBe(sweep.innerInstructionSetHash);

      // ===== insert-time validation on the forwarded bytes =====
      const draft = await buildGateProposeIxs({
        refs: refsOf(dao),
        requester: dao.voter.publicKey,
        name: "draft for refusals",
        innerIxs: [],
        directIxs: [
          SystemProgram.transfer({
            fromPubkey: dao.nativeTreasury,
            toPubkey: recipient,
            lamports: 1,
          }),
        ],
        wrapCtx: {
          multisigPda: dao.multisigPda,
          vaultIndex: 0,
          transactionIndex: await nextSquadsTxIndex(ctx, dao),
          member: dao.nativeTreasury,
        },
        holdUpSeconds: dao.params.holdUpSeconds,
      });
      await send(ctx, draft.groups.create, [dao.voter], dao.voter);
      const foreignProgram = Keypair.generate().publicKey;
      const refusedInsert = async (
        ix: TransactionInstruction,
        index: number,
      ) =>
        sendExpectFail(
          ctx,
          [
            await buildGateInsertTransactionIx({
              refs: refsOf(dao),
              requester: dao.voter.publicKey,
              proposal: draft.proposal,
              index,
              holdUpSeconds: dao.params.holdUpSeconds,
              instruction: ix,
            }),
          ],
          [dao.voter],
        );
      // off-menu DIRECT leg
      expect(
        await refusedInsert(
          new TransactionInstruction({
            programId: foreignProgram,
            keys: [],
            data: Buffer.from([1]),
          }),
          0,
        ),
      ).toMatch(/outside the gate whitelist/i);
      // any GOVERNANCE-PROGRAM leg while guarded (config immutability)
      expect(
        await refusedInsert(
          createSetGovernanceConfig(
            SPL_GOVERNANCE_PROGRAM_ID,
            PROGRAM_VERSION,
            dao.governance,
            (await readGov(ctx, dao.governance, Governance)).config,
          ),
          0,
        ),
      ).toMatch(/no governance-program leg|GovernanceSelfCallRefused/i);
      // an off-menu program SMUGGLED INSIDE the Squads vault message
      const smuggleChain = wrap(
        [
          new TransactionInstruction({
            programId: foreignProgram,
            keys: [],
            data: Buffer.from([9]),
          }),
        ],
        {
          multisigPda: dao.multisigPda,
          vaultIndex: 0,
          transactionIndex: await nextSquadsTxIndex(ctx, dao),
          member: dao.nativeTreasury,
        },
      );
      expect(await refusedInsert(smuggleChain[0]!, 0)).toMatch(
        /outside the gate whitelist/i,
      );
      // nobody bypasses the gate with a direct InsertTransaction (the
      // gate PDA cannot countersign as the proposal owner's authority)
      const bypass: TransactionInstruction[] = [];
      await withInsertTransaction(
        bypass,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.governance,
        draft.proposal,
        gateTor,
        dao.voter.publicKey, // not the gate — must be refused
        0,
        0,
        dao.params.holdUpSeconds,
        [
          createInstructionData(
            new TransactionInstruction({
              programId: foreignProgram,
              keys: [],
              data: Buffer.from([7]),
            }),
          ),
        ],
        dao.voter.publicKey,
      );
      expect(await sendExpectFail(ctx, bypass, [dao.voter])).toMatch(
        /custom program error/i,
      );
      // requester-gating: a different key may not act on the draft
      const intruder = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: intruder.publicKey,
            lamports: 1_000_000_000,
          }),
        ],
        [],
      );
      expect(
        await sendExpectFail(
          ctx,
          [
            await buildGateInsertTransactionIx({
              refs: refsOf(dao),
              requester: intruder.publicKey,
              proposal: draft.proposal,
              index: 0,
              holdUpSeconds: dao.params.holdUpSeconds,
              instruction: SystemProgram.transfer({
                fromPubkey: dao.nativeTreasury,
                toPubkey: intruder.publicKey,
                lamports: 1,
              }),
            }),
          ],
          [intruder],
        ),
      ).toMatch(/NotTheRequester|original requester|custom program error/i);
      // the requester cancels their draft (releases the outstanding slot)
      await send(
        ctx,
        [
          buildGateCancelIx({
            refs: refsOf(dao),
            requester: dao.voter.publicKey,
            proposal: draft.proposal,
          }),
        ],
        [dao.voter],
      );
      expect((await readGov(ctx, draft.proposal, Proposal)).state).toBe(
        ProposalState.Cancelled,
      );

      // ===== the sweep passes and executes faithfully =====
      const before = await balance(ctx, recipient);
      await passAndExecute(ctx, dao, sweep, gateTor);
      expect((await balance(ctx, recipient)) - before).toBe(VAULT_FUND);

      // ===== the human council veto survives the gate seat dilution =====
      const vetoed = await gatePropose(
        ctx,
        dao,
        [
          SystemProgram.transfer({
            fromPubkey: dao.vaultPda,
            toPubkey: recipient,
            lamports: 1,
          }),
        ],
        "vetoed by the humans",
      );
      await castCouncilVeto(ctx, dao, vetoed.proposal, 0, gateTor);
      expect((await readGov(ctx, vetoed.proposal, Proposal)).state).toBe(
        ProposalState.Voting, // one of two humans is not enough
      );
      await castCouncilVeto(ctx, dao, vetoed.proposal, 1, gateTor);
      expect((await readGov(ctx, vetoed.proposal, Proposal)).state).toBe(
        ProposalState.Vetoed,
      );

      // ===== exit: the voted ratchet, then convergence to MVP shape =====
      // release is refused while still guarded
      expect(
        await sendExpectFail(
          ctx,
          [
            buildReleaseRealmAuthorityIx({
              realm: dao.realm,
              governance: dao.governance,
            }),
          ],
          [],
        ),
      ).toMatch(/still guarded|StillGuarded/i);

      const ratchet = await gatePropose(
        ctx,
        dao,
        [],
        "ratchet to council",
        [
          buildRatchetIx({
            realm: dao.realm,
            governance: dao.governance,
            newMode: 1,
          }),
        ],
      );
      await passAndExecute(ctx, dao, ratchet, gateTor);
      const gateInfo = await ctx.banksClient.getAccount(gate);
      expect(Buffer.from(gateInfo!.data)[144]).toBe(1); // mode: council

      // realm authority hands over to the governance (permissionless now)
      await send(
        ctx,
        [
          buildReleaseRealmAuthorityIx({
            realm: dao.realm,
            governance: dao.governance,
          }),
        ],
        [],
      );
      expect(
        (await readGov(ctx, dao.realm, Realm)).authority?.toBase58(),
      ).toBe(dao.governance.toBase58());

      // arbitrary (previously off-menu) inserts pass the gate post-ratchet
      const arbitrary = await gatePropose(
        ctx,
        dao,
        [],
        "arbitrary after ratchet",
        [
          new TransactionInstruction({
            programId: foreignProgram,
            keys: [],
            data: Buffer.from([42]),
          }),
        ],
      );
      expect((await readGov(ctx, arbitrary.proposal, Proposal)).state).toBe(
        ProposalState.Voting,
      );

      // the voted config restore reopens direct creation (full MVP shape)
      const currentConfig = (await readGov(ctx, dao.governance, Governance))
        .config;
      currentConfig.minCommunityTokensToCreateProposal = new BN(
        dao.params.proposalThresholdTokens.toString(),
      );
      const restore = await gatePropose(
        ctx,
        dao,
        [],
        "restore direct creation",
        [
          createSetGovernanceConfig(
            SPL_GOVERNANCE_PROGRAM_ID,
            PROGRAM_VERSION,
            dao.governance,
            currentConfig,
          ),
        ],
      );
      await passAndExecute(ctx, dao, restore, gateTor);

      // ...and the voter can finally author WITHOUT the gate
      const directNow: TransactionInstruction[] = [];
      await withCreateProposal(
        directNow,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        dao.voterTor,
        "direct after exit",
        "x",
        dao.mint,
        dao.voter.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        dao.voter.publicKey,
      );
      await send(ctx, directNow, [dao.voter], dao.voter);
    },
    TEST_TIMEOUT,
  );
});
