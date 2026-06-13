"use client";

/**
 * Proposal view — fully client-side (no server). Reads proposal state from
 * the user's RPC and renders state, veto status, the published
 * instruction-set hash, the INV-3 hold-up countdown / execute gate, and the
 * wallet vote panel. Query overrides (?votingCompletedAt=&holdUpSeconds=)
 * drive the hold-up gate without an RPC for demos/tests.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { executeButtonState } from "@daofun/sdk/launch-form";
import { getConnection } from "../lib/solana";
import { getProposalState, type ProposalChainState } from "../lib/chain";
import { WalletActions } from "./wallet-actions";

function num(v: string | null): number | undefined {
  return v !== null && v !== "" ? Number(v) : undefined;
}

export function ProposalScreen() {
  const q = useSearchParams();
  const id = q.get("id") ?? "";
  const overrideHoldUp = num(q.get("holdUpSeconds"));
  const overrideVoting = num(q.get("votingCompletedAt"));
  const usingOverrides =
    overrideHoldUp !== undefined || overrideVoting !== undefined;

  const [chain, setChain] = useState<ProposalChainState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

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
        const s = await getProposalState(getConnection(), pk);
        if (!cancelled) setChain(s);
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

      <WalletActions proposal={id} />
    </>
  );
}
