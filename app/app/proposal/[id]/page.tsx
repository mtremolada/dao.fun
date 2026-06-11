import { ProposalView } from "../../../components/proposal-view";

/**
 * Proposal view — spec 6.7. The chain-derived inputs (recomputed hash,
 * voting timestamps) arrive as query params for now; the Stage 1 chain
 * reader will supply them server-side. The artifact itself is fetched
 * from the backend API by (proposal, hash).
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
  return (
    <>
      <h1>Proposal</h1>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        {id}
      </p>
      <ProposalView
        proposal={id}
        artifactHash={q.artifactHash ?? null}
        chainHash={q.chainHash ?? ""}
        votingCompletedAt={Number(q.votingCompletedAt ?? 0)}
        holdUpSeconds={Number(q.holdUpSeconds ?? 0)}
      />
    </>
  );
}
