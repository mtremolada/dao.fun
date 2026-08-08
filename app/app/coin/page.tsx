import { Suspense } from "react";
import { CoinScreen } from "../../components/coin-screen";

export const metadata = { title: "Coin — dao.fun" };

export default function CoinPage() {
  return (
    <Suspense fallback={<div className="card">Loading…</div>}>
      <CoinScreen />
    </Suspense>
  );
}
