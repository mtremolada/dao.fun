import { Suspense } from "react";
import { DaoScreen } from "../../components/dao-screen";

// Static route; realm/vault/wallet come from the query string (client-side)
// so it works on static hosting with no server.
export default function DaoPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <DaoScreen />
    </Suspense>
  );
}
