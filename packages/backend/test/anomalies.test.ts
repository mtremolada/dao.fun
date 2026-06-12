/**
 * Proposal anomaly detection — GATE 2 observability, spec 12.3 red-flag
 * heuristics ("inform, never block outside Guarded"). Written before
 * implementation. Pure function over the chain-derived proposal state;
 * the /chain/proposals route surfaces the result so the UI renders flags
 * without re-deriving them.
 */
import { describe, expect, it } from "vitest";
import {
  detectProposalAnomalies,
  type ProposalChainState,
} from "../src/chain-reader";

function state(over: Partial<ProposalChainState>): ProposalChainState {
  return {
    proposal: "prop",
    name: "p",
    state: "Voting",
    votingCompletedAt: null,
    holdUpSeconds: 72 * 3600,
    chainHash: "a".repeat(64),
    publishedArtifactHash: "a".repeat(64),
    vetoVoteWeight: "0",
    vetoed: false,
    ...over,
  };
}

describe("detectProposalAnomalies", () => {
  it("a healthy proposal has no anomalies", () => {
    expect(detectProposalAnomalies(state({}))).toEqual([]);
  });

  it("INV-9: hash mismatch between artifact and chain is flagged", () => {
    const a = detectProposalAnomalies(
      state({ publishedArtifactHash: "b".repeat(64) }),
    );
    expect(a).toContain("hash-mismatch");
  });

  it("a proposal published without an artifact hash is flagged (nothing hidden, INV-10)", () => {
    const a = detectProposalAnomalies(state({ publishedArtifactHash: null }));
    expect(a).toContain("missing-artifact-hash");
  });

  it("zero hold-up is flagged (the sovereign out-of-warranty surface)", () => {
    expect(detectProposalAnomalies(state({ holdUpSeconds: 0 }))).toContain(
      "zero-hold-up",
    );
  });

  it("a proposal with no instructions at all is flagged", () => {
    const a = detectProposalAnomalies(
      state({ chainHash: null, publishedArtifactHash: null }),
    );
    expect(a).toContain("no-instructions");
    // and it is NOT a hash mismatch — nothing to compare
    expect(a).not.toContain("hash-mismatch");
  });

  it("a veto is state, not an anomaly (council mode working as designed)", () => {
    expect(detectProposalAnomalies(state({ vetoed: true, state: "Vetoed" })))
      .toEqual([]);
  });
});
