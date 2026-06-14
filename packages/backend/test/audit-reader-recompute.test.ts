/**
 * AUDIT F-8 — the chain-side INV-9 recompute must cover EVERYTHING that will
 * execute, by the proposal's authoritative on-chain transaction count, or
 * report that it could not. Before the fix the reader scanned a fixed cap of
 * 32 transactions and broke on the first gap, so an adversarial proposer
 * (arbitrary proposals are allowed in MVP — byte-enforcement is Stage 3) could:
 *
 *   - append a 33rd ProposalTransaction (a hidden vault drain) past the cap:
 *     the recompute hashed only the first 32, so a descriptionLink set to that
 *     truncated hash showed a GREEN "verified" badge while the 33rd executed;
 *   - bury a zero-hold-up leg among slow legs: the reader reported the MAX
 *     hold-up, masking the leg that can execute immediately (INV-3).
 *
 * These tests pin the hardened `collectProposalTransactions` (the exact
 * discovery/aggregation logic `RpcChainReader.getProposalState` runs): it reads
 * by `instructionsNextIndex`, never silently truncates, reports the MIN
 * hold-up, and flags an incomplete read so the badge can never read "verified"
 * over a prefix.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  collectProposalTransactions,
  detectProposalAnomalies,
  type ProposalChainState,
  type ProposalTxData,
} from "../src/chain-reader";
import { computeInstructionSetHash } from "../src/artifacts";

/** One distinct single-instruction ProposalTransaction per index. */
function fakeTx(index: number, holdUpTime = 72 * 3600): ProposalTxData {
  return {
    holdUpTime,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: Keypair.generate().publicKey,
        toPubkey: Keypair.generate().publicKey,
        // unique amount per index -> a hidden index changes the set hash
        lamports: 1_000_000 + index,
      }),
    ],
  };
}

function baseState(over: Partial<ProposalChainState>): ProposalChainState {
  return {
    proposal: "p",
    name: "p",
    state: "Voting",
    votingCompletedAt: null,
    holdUpSeconds: 72 * 3600,
    chainHash: "a".repeat(64),
    publishedArtifactHash: "a".repeat(64),
    instructionSetComplete: true,
    singleOption: true,
    vetoVoteWeight: "0",
    vetoed: false,
    ...over,
  };
}

describe("AUDIT F-8: chain-reader recompute covers the full executed set", () => {
  it("reads ALL transactions by the authoritative count — no 32-cap truncation", async () => {
    const txs = Array.from({ length: 33 }, (_, i) => fakeTx(i));
    const got = await collectProposalTransactions(
      33, // options[0].instructionsNextIndex
      async (i) => txs[i] ?? null,
    );
    expect(got.complete).toBe(true);
    expect(got.wrapped).toHaveLength(33);

    // The hidden 33rd instruction (index 32) IS in the recomputed hash now.
    const full = computeInstructionSetHash(got.wrapped);
    const truncatedTo32 = computeInstructionSetHash(
      txs.slice(0, 32).flatMap((t) => t.instructions),
    );
    expect(full).not.toBe(truncatedTo32);
    // ...and the 33rd instruction's bytes are part of what was hashed.
    expect(got.wrapped[32]!.data.equals(txs[32]!.instructions[0]!.data)).toBe(
      true,
    );
  });

  it("flags an incomplete read when the claimed count exceeds the ceiling", async () => {
    const got = await collectProposalTransactions(
      500, // claims far more than the read ceiling
      async (i) => fakeTx(i),
      128,
    );
    expect(got.complete).toBe(false); // never silently 'verified'
    const anomalies = detectProposalAnomalies(
      baseState({ instructionSetComplete: got.complete }),
    );
    expect(anomalies).toContain("incomplete-instruction-set");
  });

  it("flags a hole within the claimed range instead of stopping early", async () => {
    const got = await collectProposalTransactions(
      10,
      async (i) => (i === 5 ? null : fakeTx(i)), // index 5 removed/unreadable
    );
    expect(got.complete).toBe(false);
    // it did NOT break at the hole — the later transactions were still read
    expect(got.wrapped).toHaveLength(9);
  });

  it("reports the MIN hold-up, so a fast leg among slow legs surfaces zero-hold-up", async () => {
    const got = await collectProposalTransactions(3, async (i) =>
      // two 72h legs and one immediate (0s) drain
      fakeTx(i, i === 1 ? 0 : 72 * 3600),
    );
    expect(got.minHoldUpSeconds).toBe(0);
    const anomalies = detectProposalAnomalies(
      baseState({ holdUpSeconds: got.minHoldUpSeconds }),
    );
    expect(anomalies).toContain("zero-hold-up");
  });

  it("an honest uniform-hold-up proposal is complete with min == the configured hold-up", async () => {
    const got = await collectProposalTransactions(4, async (i) =>
      fakeTx(i, 72 * 3600),
    );
    expect(got.complete).toBe(true);
    expect(got.minHoldUpSeconds).toBe(72 * 3600);
    expect(detectProposalAnomalies(baseState({}))).toEqual([]);
  });
});
