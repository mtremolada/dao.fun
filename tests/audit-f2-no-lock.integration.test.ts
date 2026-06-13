/**
 * AUDIT F-2 (MEDIUM) — in the SHIPPING no-addin realm, a voter is NOT locked
 * through the drain. Demonstrated on the real spl-governance binary.
 *
 * REDTEAM.md §1.2 and the property suite ground the anti-capture guarantee in
 * "EITHER the attacker's capital is still locked when the drain executes OR the
 * drain took >= saturation x quorum% of public notice" — a dichotomy that
 * assumes VSR lockup weighting. But every pump mint is Token-2022 and the
 * deployed VSR rejects it (D-013), so production realms are built WITH NO ADDIN
 * (`communityVoterWeightAddin: null`) and vote weight == plain deposited tokens
 * with NO lockup. The harness reproduces exactly that config.
 *
 * This proves the "locked-through-drain" arm is FALSE for the shipped config:
 * a voter deposits, votes a fund-draining proposal to success, then RELINQUISHES
 * and WITHDRAWS the full stake back to their own wallet — recovering all capital
 * BEFORE the hold-up elapses and the drain executes. The tally is unaffected;
 * the drain still lands. The only real protection left is (a) the cost of
 * amassing quorum-weight of supply and (b) the voting-window + hold-up NOTICE
 * (+ council veto in council mode) — not capital-at-risk-through-execution.
 */
import { describe, expect, it } from "vitest";
import { TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Proposal,
  ProposalState,
  getVoteRecordAddress,
  withRelinquishVote,
  withWithdrawGoverningTokens,
} from "@solana/spl-governance";
import {
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  proposeSweep,
  readGov,
  send,
  startCtx,
  warpSeconds,
  MICRO_HOLDUP_S,
} from "./helpers/bankrun-harness";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";

async function tokenBalance(
  ctx: Awaited<ReturnType<typeof startCtx>>,
  ata: ReturnType<typeof getAssociatedTokenAddressSync>,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(ata);
  if (!info) return 0n;
  // SPL token account: amount is a u64 LE at offset 64.
  return Buffer.from(info.data).readBigUInt64LE(64);
}

describe("AUDIT F-2: no-addin realm does not lock the voter through the drain (real binary)", () => {
  it(
    "the voter recovers the full stake BEFORE execution, and the drain still lands",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk"); // no-addin (D-013), like production

      const voterAta = getAssociatedTokenAddressSync(
        dao.mint,
        dao.voter.publicKey,
      );
      // The full supply is locked in the realm as the deposited vote weight.
      expect(await tokenBalance(ctx, voterAta)).toBe(0n);

      const made = await proposeSweep(ctx, dao, 0);
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // Voting is over and the proposal SUCCEEDED. The voter now unwinds:
      // relinquish the (already-counted) vote, then withdraw the whole stake.
      const voteRecord = await getVoteRecordAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        made.proposal,
        dao.voterTor,
      );
      const relinquish: TransactionInstruction[] = [];
      await withRelinquishVote(
        relinquish,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        dao.voterTor,
        dao.mint,
        voteRecord,
        dao.voter.publicKey,
        dao.voter.publicKey,
      );
      await send(ctx, relinquish, [dao.voter]);

      const withdraw: TransactionInstruction[] = [];
      await withWithdrawGoverningTokens(
        withdraw,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voterAta,
        dao.mint,
        dao.voter.publicKey,
      );
      await send(ctx, withdraw, [dao.voter]);

      // CAPITAL RECOVERED IN FULL, while the proposal is still in its hold-up
      // window and the vault is still funded (drain has NOT executed).
      expect(await tokenBalance(ctx, voterAta)).toBe(SUPPLY);
      expect(await balance(ctx, dao.vaultPda)).toBe(VAULT_FUND);
      expect((await readGov(ctx, made.proposal, Proposal)).state).toBe(
        ProposalState.Succeeded,
      );

      // ...and the drain still lands after the hold-up — the voter was never
      // at risk through execution.
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);
      expect(await balance(ctx, dao.vaultPda)).toBe(0);
      expect(await balance(ctx, made.recipient)).toBe(VAULT_FUND);
    },
    TEST_TIMEOUT,
  );
});
