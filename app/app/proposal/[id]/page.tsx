import type { ProposalChainState } from "@daofun/backend";
import { ProposalView } from "../../../components/proposal-view";
import { WalletActions } from "../../../components/wallet-actions";

// Server-side reads go straight to the backend (same target the /api
// rewrite proxies to for the browser).
const API = process.env.API_URL ?? "http://127.0.0.1:4404";

/**
 * Proposal view — spec 6.7. Chain-derived inputs (recomputed hash, voting
 * timestamps, hold-up, veto status) come from the chain reader via
 * /chain/proposals/:id; query params override them for manual inspection
 * and the simulated-mismatch e2e.
 */
export default async function ProposalPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const q = await searchParams;

  // The /chain/proposals route augments the reader state with the computed
  // `anomalies` array (INV-10 red flags); surface them in the view.
  let chain: (ProposalChainState & { anomalies?: string[] }) | null = null;
  if (!q.chainHash) {
    try {
      const res = await fetch(`${API}/chain/proposals/${id}`, {
        cache: "no-store",
      });
      if (res.ok)
        chain = (await res.json()) as ProposalChainState & {
          anomalies?: string[];
        };
    } catch {
      // reader unavailable — fall through to query params / empty state
    }
  }

  return (
    <>
      <h1>Proposal</h1>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        {id}
        {chain && ` — ${chain.name}`}
      </p>
      <ProposalView
        proposal={id}
        artifactHash={q.artifactHash ?? chain?.publishedArtifactHash ?? null}
        chainHash={q.chainHash ?? chain?.chainHash ?? ""}
        votingCompletedAt={
          q.votingCompletedAt !== undefined
            ? Number(q.votingCompletedAt)
            : (chain?.votingCompletedAt ?? 0)
        }
        holdUpSeconds={
          q.holdUpSeconds !== undefined
            ? Number(q.holdUpSeconds)
            : (chain?.holdUpSeconds ?? 0)
        }
        proposalState={chain?.state ?? null}
        anomalies={chain?.anomalies ?? []}
        veto={
          chain
            ? { vetoed: chain.vetoed, vetoVoteWeight: chain.vetoVoteWeight }
            : null
        }
      />
      <WalletActions proposal={id} />
    </>
  );
}
