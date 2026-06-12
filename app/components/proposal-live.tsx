"use client";

/**
 * Decentralized proposal view: reads the proposal state, recomputes the INV-9
 * hash + anomalies, and decodes the effects ENTIRELY in the browser from chain
 * (no backend). Rendered by the proposal page when NEXT_PUBLIC_RPC_URL is set.
 */
import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  RpcChainReader,
  decodeProposalFromChain,
  detectProposalAnomalies,
  type ProposalChainState,
} from "@daofun/sdk";
import { ProposalView } from "./proposal-view";

export function ProposalLive({ id, rpcUrl }: { id: string; rpcUrl: string }) {
  const [state, setState] = useState<ProposalChainState | null>(null);
  const [anomalies, setAnomalies] = useState<string[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const proposal = new PublicKey(id);
        const s = await new RpcChainReader(connection).getProposalState(proposal);
        if (cancelled) return;
        if (!s) {
          setError("Proposal not found on chain");
          return;
        }
        setState(s);
        setAnomalies(detectProposalAnomalies(s));
        const decoded = await decodeProposalFromChain(connection, proposal);
        if (!cancelled && decoded) {
          setSummary(
            decoded.summary +
              (decoded.partial
                ? "\n(partial — the on-chain set could not be fully read)"
                : ""),
          );
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, rpcUrl]);

  if (error) {
    return (
      <p className="errors" data-testid="proposal-error">
        {error}
      </p>
    );
  }
  if (!state) {
    return <p className="muted">Reading proposal from chain…</p>;
  }

  return (
    <ProposalView
      proposal={id}
      artifactHash={state.publishedArtifactHash}
      chainHash={state.chainHash ?? ""}
      votingCompletedAt={state.votingCompletedAt ?? 0}
      holdUpSeconds={state.holdUpSeconds}
      proposalState={state.state}
      anomalies={anomalies}
      veto={{ vetoed: state.vetoed, vetoVoteWeight: state.vetoVoteWeight }}
      decodedSummary={summary}
    />
  );
}
