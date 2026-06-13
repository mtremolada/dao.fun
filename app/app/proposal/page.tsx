"use client";

/**
 * Proposal page — spec 6.7, server-less (D-033). `?id=` selects the proposal;
 * its state is read directly from the chain in the browser (no backend) via
 * the SDK's RpcChainReader over the user's RPC. Query params (chainHash,
 * artifactHash, votingCompletedAt, holdUpSeconds) override chain values for
 * manual inspection and the simulated-mismatch e2e.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import {
  detectProposalAnomalies,
  type ProposalChainState,
} from "@daofun/sdk/chain-reader";
import { getChainReader } from "../../lib/rpc";
import { ProposalView } from "../../components/proposal-view";
import { WalletActions } from "../../components/wallet-actions";
import { RpcSettings } from "../../components/rpc-settings";

type Status = "idle" | "loading" | "loaded" | "notfound" | "error";

function ProposalInner() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const qChainHash = params.get("chainHash");
  const qArtifactHash = params.get("artifactHash");
  const qVotingCompletedAt = params.get("votingCompletedAt");
  const qHoldUpSeconds = params.get("holdUpSeconds");

  const [chain, setChain] = useState<ProposalChainState | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setStatus("idle");
      return;
    }
    // Query override: when chainHash is supplied, render from query params
    // alone (manual inspection / e2e) and skip the chain read.
    if (qChainHash !== null) {
      setChain(null);
      setStatus("loaded");
      return;
    }
    let proposal: PublicKey;
    try {
      proposal = new PublicKey(id);
    } catch {
      setStatus("error");
      setError("invalid proposal pubkey");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const s = await getChainReader().getProposalState(proposal);
        if (cancelled) return;
        if (!s) {
          setStatus("notfound");
          return;
        }
        setChain(s);
        setStatus("loaded");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, qChainHash]);

  if (!id) {
    return (
      <>
        <h1>Proposal</h1>
        <p className="errors" data-testid="proposal-error">
          Missing ?id= — pass the proposal pubkey.
        </p>
      </>
    );
  }

  const artifactHash = qArtifactHash ?? chain?.publishedArtifactHash ?? null;
  const chainHash = qChainHash ?? chain?.chainHash ?? "";
  const votingCompletedAt =
    qVotingCompletedAt !== null
      ? Number(qVotingCompletedAt)
      : (chain?.votingCompletedAt ?? 0);
  const holdUpSeconds =
    qHoldUpSeconds !== null
      ? Number(qHoldUpSeconds)
      : (chain?.holdUpSeconds ?? 0);
  const anomalies = chain ? detectProposalAnomalies(chain) : [];

  return (
    <>
      <h1>Proposal</h1>
      <RpcSettings />
      <p className="muted" style={{ wordBreak: "break-all" }}>
        {id}
        {chain && ` — ${chain.name}`}
      </p>
      {status === "loading" && <p className="muted">Reading chain…</p>}
      {status === "error" && (
        <p className="errors" data-testid="proposal-error">
          {error}
        </p>
      )}
      {status === "notfound" && (
        <p className="errors" data-testid="proposal-error">
          not found
        </p>
      )}
      <ProposalView
        proposal={id}
        artifactHash={artifactHash}
        chainHash={chainHash}
        votingCompletedAt={votingCompletedAt}
        holdUpSeconds={holdUpSeconds}
        proposalState={chain?.state ?? null}
        veto={
          chain
            ? { vetoed: chain.vetoed, vetoVoteWeight: chain.vetoVoteWeight }
            : null
        }
        anomalies={anomalies}
      />
      <WalletActions proposal={id} />
    </>
  );
}

export default function ProposalPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <ProposalInner />
    </Suspense>
  );
}
