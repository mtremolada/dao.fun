"use client";

/**
 * Proposal view — spec 6.7, server-less (D-033). The trust surface is
 * recomputed in the browser: the INV-9 hash badge compares the hash of the
 * ACTUAL on-chain instructions (recomputed client-side) against the hash the
 * proposer published, and the red flags come from detectProposalAnomalies
 * over chain state. No server decode store is in the path; both hashes are
 * shown raw so anyone can re-verify independently. Badge and execute-button
 * state come from the shared contract, not component logic.
 */
import { useEffect, useState } from "react";
import { executeButtonState, hashBadge } from "@daofun/sdk/launch-form";

const BADGE_COPY = {
  verified: "Verified against chain",
  mismatch: "MISMATCH — on-chain instructions differ from the published hash",
  missing: "No published hash — nothing to verify against",
} as const;

const ANOMALY_COPY: Record<string, string> = {
  "no-instructions": "This proposal carries no executable instructions.",
  "hash-mismatch":
    "On-chain instructions do NOT match the published artifact hash (INV-9).",
  "missing-artifact-hash":
    "Instructions exist but no artifact hash was published (INV-10).",
  "zero-hold-up": "Hold-up is zero — funds can move the instant a vote passes.",
};

export function ProposalView(props: {
  proposal: string;
  artifactHash: string | null;
  chainHash: string;
  votingCompletedAt: number;
  holdUpSeconds: number;
  proposalState?: string | null;
  veto?: { vetoed: boolean; vetoVoteWeight: string } | null;
  anomalies?: string[];
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const badge = hashBadge(props.chainHash, props.artifactHash);
  const execute = executeButtonState(
    now,
    props.votingCompletedAt,
    props.holdUpSeconds,
  );
  const anomalies = props.anomalies ?? [];

  return (
    <>
      <p>
        <span className="badge" data-testid="hash-badge" data-state={badge}>
          {BADGE_COPY[badge]}
        </span>
      </p>

      {props.proposalState && (
        <p data-testid="proposal-state">
          State: <strong>{props.proposalState}</strong>
        </p>
      )}
      {props.veto && (
        <p data-testid="veto-status">
          {props.veto.vetoed ? (
            <span className="badge" data-state="mismatch">
              VETOED by the council
            </span>
          ) : (
            <span className="muted">
              No veto (council veto weight cast: {props.veto.vetoVoteWeight})
            </span>
          )}
        </p>
      )}

      <h2>Verify (INV-9)</h2>
      <p className="muted" style={{ wordBreak: "break-all" }} data-testid="chain-hash">
        recomputed from chain: {props.chainHash || "(no instructions)"}
        <br />
        published by proposer: {props.artifactHash ?? "(none)"}
      </p>

      <h2>Red flags</h2>
      {anomalies.length === 0 ? (
        <p className="muted" data-testid="red-flags">
          none
        </p>
      ) : (
        <ul className="errors" data-testid="red-flags">
          {anomalies.map((a) => (
            <li key={a}>{ANOMALY_COPY[a] ?? a}</li>
          ))}
        </ul>
      )}

      <h2>Execution</h2>
      {!execute.enabled && (
        <p className="muted" data-testid="holdup-countdown">
          Hold-up remaining: {execute.remainingSeconds}s
        </p>
      )}
      <p className="muted">
        Execution after the hold-up is permissionless — anyone (a keeper, or
        you) can submit it once the window elapses.
      </p>
      <button
        className="button"
        type="button"
        data-testid="execute-button"
        disabled={!execute.enabled}
      >
        {execute.enabled ? "Executable now" : "Locked (hold-up)"}
      </button>
    </>
  );
}
