"use client";

/**
 * Proposal view — fully client-side (no server). The browser reads proposal
 * state from the user's RPC, RECOMPUTES the INV-9 instruction-set hash from
 * chain, DECODES the real effects (INV-10), surfaces anomaly flags, shows the
 * hold-up countdown / execute gate, and lets anyone crank execution once the
 * hold-up elapses. Query overrides (?votingCompletedAt=&holdUpSeconds=) drive
 * the hold-up gate without an RPC for demos/tests.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { executeButtonState } from "@daofun/sdk/launch-form";
import { getConnection } from "../lib/solana";
import {
  decodeProposal,
  detectProposalAnomalies,
  getProposalState,
  type ProposalChainState,
  type ProposalDecode,
} from "../lib/chain";
import { runExecute, type ExecuteStep } from "../lib/execute";
import { useWallet } from "./wallet-provider";
import { WalletActions } from "./wallet-actions";

function num(v: string | null): number | undefined {
  return v !== null && v !== "" ? Number(v) : undefined;
}

/** Plain-English label for each anomaly flag (spec 12.3 — inform, never hide). */
const ANOMALY_COPY: Record<string, string> = {
  "hash-mismatch":
    "On-chain instructions do NOT match the published hash — do not trust this proposal.",
  "missing-artifact-hash":
    "No published hash to compare against — verify the decoded effects yourself.",
  "no-instructions": "This proposal has no executable instructions.",
  "zero-hold-up":
    "Zero hold-up — if this passes it can execute immediately (sovereign).",
  "incomplete-instruction-set":
    "Could not fully re-read the instruction set — the hash covers only part of it.",
  "unexpected-proposal-shape":
    "Unusual proposal shape — instructions could execute outside what is shown.",
};

export function ProposalScreen() {
  const q = useSearchParams();
  const { sender, openModal } = useWallet();
  const id = q.get("id") ?? "";
  const overrideHoldUp = num(q.get("holdUpSeconds"));
  const overrideVoting = num(q.get("votingCompletedAt"));
  const usingOverrides =
    overrideHoldUp !== undefined || overrideVoting !== undefined;

  const [chain, setChain] = useState<ProposalChainState | null>(null);
  const [decoded, setDecoded] = useState<
    (ProposalDecode & { partial: boolean }) | null
  >(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [execSteps, setExecSteps] = useState<ExecuteStep[]>([]);
  const [executing, setExecuting] = useState(false);
  const [execDone, setExecDone] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!id || usingOverrides) {
        setLoaded(true);
        return;
      }
      let pk: PublicKey;
      try {
        pk = new PublicKey(id);
      } catch {
        setLoaded(true);
        return;
      }
      try {
        const conn = getConnection();
        const [s, d] = await Promise.all([
          getProposalState(conn, pk),
          decodeProposal(conn, pk).catch(() => null),
        ]);
        if (!cancelled) {
          setChain(s);
          setDecoded(d);
        }
      } catch {
        // RPC unreachable — render what we can, never crash
      }
      if (!cancelled) setLoaded(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, usingOverrides]);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (!id) {
    return (
      <>
        <h1>Proposal</h1>
        <p className="errors" data-testid="proposal-error">
          Missing ?id= — pass a proposal address.
        </p>
      </>
    );
  }

  const votingCompletedAt = overrideVoting ?? chain?.votingCompletedAt ?? 0;
  const holdUpSeconds = overrideHoldUp ?? chain?.holdUpSeconds ?? 0;
  const execute = executeButtonState(now, votingCompletedAt, holdUpSeconds);
  const anomalies = chain ? detectProposalAnomalies(chain) : [];
  const verified =
    chain?.chainHash != null &&
    chain.publishedArtifactHash != null &&
    chain.chainHash === chain.publishedArtifactHash &&
    chain.instructionSetComplete &&
    chain.singleOption;
  const succeeded = chain?.state === "Succeeded";

  async function onExecute() {
    setExecError(null);
    if (!sender) {
      openModal();
      return;
    }
    setExecuting(true);
    setExecSteps([]);
    try {
      await runExecute(getConnection(), sender, new PublicKey(id), (s) =>
        setExecSteps((prev) => [...prev.filter((p) => p.index !== s.index), s]),
      );
      setExecDone(true);
    } catch (e) {
      setExecError((e as Error).message);
    } finally {
      setExecuting(false);
    }
  }

  return (
    <>
      <h1>Proposal</h1>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        {id}
        {chain && ` — ${chain.name}`}
      </p>
      {!loaded && <p className="muted">Loading proposal…</p>}

      {chain?.state && (
        <p data-testid="proposal-state">
          State: <strong>{chain.state}</strong>
        </p>
      )}

      {/* INV-9: verified-against-chain badge, recomputed in the browser */}
      {chain && (
        <p data-testid="hash-badge">
          {verified ? (
            <span className="badge" data-state="verified">
              ✓ Instructions verified against chain
            </span>
          ) : (
            <span className="badge" data-state="mismatch">
              ⚠ Not verified — see flags below
            </span>
          )}
        </p>
      )}

      {chain && anomalies.length > 0 && (
        <ul className="errors" data-testid="anomalies">
          {anomalies.map((a) => (
            <li key={a}>{ANOMALY_COPY[a] ?? a}</li>
          ))}
        </ul>
      )}

      {/* INV-10: decoded effects — unknown instructions are flagged, never hidden */}
      {decoded && (
        <div data-testid="decoded">
          <h2>What this proposal does</h2>
          {decoded.partial && (
            <p className="errors">
              ⚠ Only part of the instruction set could be read.
            </p>
          )}
          <ul className="result">
            {decoded.instructions.map((d, i) => (
              <li key={i}>
                <strong>{d.program}</strong>: {d.summary}
                {d.flags.length > 0 && (
                  <span className="muted"> [{d.flags.join(", ")}]</span>
                )}
              </li>
            ))}
          </ul>
          {decoded.redFlags.length > 0 && (
            <p className="errors" data-testid="red-flags">
              Red flags: {decoded.redFlags.join(", ")}
            </p>
          )}
        </div>
      )}

      {chain && (
        <p data-testid="veto-status">
          {chain.vetoed ? (
            <span className="badge" data-state="mismatch">
              VETOED by the council
            </span>
          ) : (
            <span className="muted">
              No veto (council veto weight cast: {chain.vetoVoteWeight})
            </span>
          )}
        </p>
      )}
      {chain?.publishedArtifactHash && (
        <p
          className="muted"
          data-testid="published-hash"
          style={{ wordBreak: "break-all" }}
        >
          Published instruction-set hash: {chain.publishedArtifactHash}
        </p>
      )}

      <h2>Execution</h2>
      {!execute.enabled && (
        <p className="muted" data-testid="holdup-countdown">
          {succeeded || usingOverrides
            ? `Hold-up remaining: ${execute.remainingSeconds}s`
            : "Execution opens once the proposal succeeds and the hold-up elapses."}
        </p>
      )}
      <button
        className="button"
        type="button"
        data-testid="execute-button"
        disabled={!execute.enabled || executing || execDone}
        onClick={() => void onExecute()}
      >
        {execDone
          ? "Executed ✅"
          : executing
            ? "Executing…"
            : sender
              ? "Execute"
              : "Connect wallet to execute"}
      </button>

      {execSteps.length > 0 && (
        <ul className="result" data-testid="execute-progress">
          {execSteps
            .sort((a, b) => a.index - b.index)
            .map((s) => (
              <li key={s.index}>
                {s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏳"}{" "}
                instruction {s.index + 1}/{s.total}
                {s.error ? ` — ${s.error}` : ""}
              </li>
            ))}
        </ul>
      )}
      {execError && (
        <p className="errors" data-testid="execute-error">
          {execError}
        </p>
      )}

      <WalletActions proposal={id} />
    </>
  );
}
