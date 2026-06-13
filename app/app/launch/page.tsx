import { Suspense } from "react";
import { LaunchScreen } from "../../components/launch-screen";

// Static route; the mode is read client-side from ?mode= so it works on
// static hosting with no server.
export default function LaunchPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LaunchScreen />
    </Suspense>
  );
}
