import { Suspense } from "react";
import { ProposalScreen } from "../../components/proposal-screen";

// Static route; the proposal address is read client-side from ?id= so deep
// links work on static hosting (GitHub Pages) with no server.
export default function ProposalPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <ProposalScreen />
    </Suspense>
  );
}
