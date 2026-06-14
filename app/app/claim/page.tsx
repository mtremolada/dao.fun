import { Suspense } from "react";
import { ListingClaimScreen } from "../../components/listing-claim-screen";

// Static route; the claim parameters are read client-side from the query so a
// deep link from the launch artifact works on static hosting (GitHub Pages)
// with no server.
export default function ClaimPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <ListingClaimScreen />
    </Suspense>
  );
}
