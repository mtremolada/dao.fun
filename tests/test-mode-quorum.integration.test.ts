/**
 * TEST-MODE governance config on the real binaries (bankrun): an Absolute max
 * community vote weight (D-014) lets a holding FAR below the full supply meet
 * quorum and pass a proposal. Proves the cheap-mainnet-test path: with a tiny
 * Absolute cap (1000 tokens) a voter whose deposit (200k tokens) vastly exceeds
 * the cap still passes + executes — i.e. "any amount" is enough; the deployed
 * SPL-Governance binary accepts yes-weight > max-vote-weight.
 */
import { describe, expect, it } from "vitest";
import { ProposalState } from "@solana/spl-governance";
import { absoluteMaxVoteWeight } from "../packages/sdk/src/governance";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  proposeSweep,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

describe("test-mode quorum: Absolute max vote weight (real binaries, bankrun)", () => {
  it(
    "a tiny Absolute cap lets a deposit far above it pass + execute (any-amount quorum)",
    async () => {
      const ctx = await startCtx();
      // 1000-token cap; the harness voter holds/deposits 200k tokens — a 200x
      // over-cap deposit, the exact 'any amount is enough' regime test mode uses.
      const dao = await createDao(ctx, "cypherpunk", {
        communityMaxVoteWeightSource: absoluteMaxVoteWeight(1000n * 10n ** 6n),
      });

      const made = await proposeSweep(ctx, dao, 0);
      await castCommunityYes(ctx, dao, made.proposal);
      // Quorum (25% of the 1000-token cap = 250 tokens) is met many times over.
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );

      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);
      expect(await balance(ctx, made.recipient)).toBe(VAULT_FUND);
    },
    TEST_TIMEOUT,
  );
});
