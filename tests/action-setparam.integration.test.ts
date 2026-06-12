/**
 * 13.6b `setParam` — against the REAL spl-governance binary (bankrun):
 *
 *   1. A cypherpunk DAO votes to raise its own hold-up 72h -> 96h. The
 *      instruction is a DIRECT leg (D-022/D-025): its only account is the
 *      governance PDA as writable signer — ExecuteTransaction must
 *      invoke_sign for the governance account itself (the verify item
 *      this suite resolves on the deployed binary). No Squads wrapping,
 *      the vault is never touched.
 *   2. Ratchet by omission: after execution the veto surface, tipping and
 *      anti-spam fields are byte-identical; ONLY the hold-up changed.
 *   3. The new value BINDS: an insert carrying the old 72h hold-up is
 *      refused by the program; a 96h proposal goes through, is refused at
 *      +72h (INV-3 under the NEW config), and executes after +96h.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { Governance, ProposalState } from "@solana/spl-governance";
import { buildSetParamIxs } from "../packages/sdk/src/actions";
import {
  BASE_VOTING_TIME_S,
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  executeIxsFor,
  finalizeAfterVotingWindow,
  proposeInner,
  readGov,
  sendExpectFail,
  startCtx,
  warpSeconds,
  SUPPLY,
} from "./helpers/bankrun-harness";

const NEW_HOLDUP_S = 96 * 3600;

describe("13.6b setParam: whitelisted governance param by vote (real binary, bankrun)", () => {
  it(
    "the DAO raises its own hold-up; non-target config is preserved; the new floor binds later proposals",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");

      // current config from CHAIN state, like the production chain reader
      const before = await readGov(ctx, dao.governance, Governance);
      expect(before.config.minInstructionHoldUpTime).toBe(MICRO_HOLDUP_S);

      const setParam = buildSetParamIxs({
        governance: dao.governance,
        currentConfig: before.config,
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId: "holdUpSeconds",
        value: BigInt(NEW_HOLDUP_S),
      });

      // ===== proposal 0: direct leg only (no vault legs at all) =====
      const vaultBefore = await balance(ctx, dao.vaultPda);
      const made = await proposeInner(
        ctx,
        dao,
        0,
        [],
        "raise hold-up to 96h",
        setParam.directIxs,
      );
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      // the governance program signed for ITSELF; config updated in place
      const after = await readGov(ctx, dao.governance, Governance);
      expect(after.config.minInstructionHoldUpTime).toBe(NEW_HOLDUP_S);
      // ratchet by omission — everything else byte-identical
      expect(after.config.communityVoteThreshold.value).toBe(
        before.config.communityVoteThreshold.value,
      );
      expect(after.config.councilVetoVoteThreshold.type).toBe(
        before.config.councilVetoVoteThreshold.type, // structurally no veto
      );
      expect(after.config.communityVoteTipping).toBe(
        before.config.communityVoteTipping,
      );
      expect(after.config.baseVotingTime).toBe(before.config.baseVotingTime);
      expect(after.config.depositExemptProposalCount).toBe(
        before.config.depositExemptProposalCount,
      );
      expect(
        after.config.minCommunityTokensToCreateProposal.eq(
          before.config.minCommunityTokensToCreateProposal,
        ),
      ).toBe(true);
      // the vault was never touched by the whole proposal
      expect(await balance(ctx, dao.vaultPda)).toBe(vaultBefore);

      // ===== the new floor BINDS on the real binary =====
      // an insert still carrying the old 72h hold-up is refused...
      const recipient = Keypair.generate().publicKey;
      const sweep = [
        SystemProgram.transfer({
          fromPubkey: dao.vaultPda,
          toPubkey: recipient,
          lamports: VAULT_FUND,
        }),
      ];
      await expect(
        proposeInner(ctx, dao, 1, sweep, "sweep under stale hold-up"),
      ).rejects.toThrow();

      // ...a 96h proposal goes through, and INV-3 now gates at 96h:
      dao.params.holdUpSeconds = NEW_HOLDUP_S;
      const sweepMade = await proposeInner(ctx, dao, 2, sweep, "sweep at 96h");
      await castCommunityYes(ctx, dao, sweepMade.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, sweepMade.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10); // the OLD floor — too early
      expect(
        await sendExpectFail(ctx, await executeIxsFor(dao, sweepMade, 0), []),
      ).toMatch(/hold up time/i);
      await warpSeconds(ctx, NEW_HOLDUP_S - MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, sweepMade);
      expect(await balance(ctx, recipient)).toBe(VAULT_FUND);

      // governance latency sanity: this whole file ran on one realm with
      // two full voting windows — both warped (BASE_VOTING_TIME_S each).
      expect(BASE_VOTING_TIME_S).toBe(3 * 86400);
    },
    TEST_TIMEOUT,
  );
});
