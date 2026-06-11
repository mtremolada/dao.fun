"use client";

/**
 * Proposal view — spec 6.7: decoded summary, simulation result, red
 * flags, the INV-9 hash badge, and the INV-3 execute button gated on the
 * hold-up countdown. Badge and button state come from the shared
 * contract (hashBadge / executeButtonState), not component logic.
 */
import { useEffect, useState } from "react";
import { executeButtonState, hashBadge } from "@daofun/sdk/launch-form";

interface Artifact {
  decodedSummary: string;
  simulation: { ok?: boolean } & Record<string, unknown>;
  redFlags: string[];
}

const BADGE_COPY = {
  verified: "Verified against chain",
  mismatch: "MISMATCH — on-chain instructions differ from the artifact",
  missing: "Artifact missing — nothing to verify against",
} as const;

export function ProposalView(props: {
  proposal: string;
  artifactHash: string | null;
  chainHash: string;
  votingCompletedAt: number;
  holdUpSeconds: number;
  /** Chain-fed extras (null when the reader is unavailable). */
  proposalState?: string | null;
  veto?: { vetoed: boolean; vetoVoteWeight: string } | null;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (props.artifactHash) {
        const res = await fetch(
          `/api/artifacts/${props.proposal}/${props.artifactHash}`,
        );
        if (!cancelled && res.ok) {
          setArtifact((await res.json()) as Artifact);
        }
      }
      if (!cancelled) setLoaded(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [props.proposal, props.artifactHash]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (!loaded) return <p className="muted">Loading artifact…</p>;

  // INV-9 surface: missing artifact is as loud as a mismatch.
  const badge = hashBadge(props.chainHash, artifact ? props.artifactHash : null);
  const execute = executeButtonState(
    now,
    props.votingCompletedAt,
    props.holdUpSeconds,
  );

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

      {artifact && (
        <>
          <h2>Decoded summary</h2>
          <p data-testid="decoded-summary">{artifact.decodedSummary}</p>

          <h2>Simulation</h2>
          <p data-testid="simulation-result">
            {artifact.simulation.ok ? "OK" : "FAILED"}{" "}
            <span className="muted">
              {JSON.stringify(artifact.simulation)}
            </span>
          </p>

          <h2>Red flags</h2>
          {artifact.redFlags.length === 0 ? (
            <p className="muted" data-testid="red-flags">
              none
            </p>
          ) : (
            <ul className="errors" data-testid="red-flags">
              {artifact.redFlags.map((flag) => (
                <li key={flag}>{flag}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <h2>Execution</h2>
      {!execute.enabled && (
        <p className="muted" data-testid="holdup-countdown">
          Hold-up remaining: {execute.remainingSeconds}s
        </p>
      )}
      <button
        className="button"
        type="button"
        data-testid="execute-button"
        disabled={!execute.enabled}
      >
        Execute
      </button>
    </>
  );
}
