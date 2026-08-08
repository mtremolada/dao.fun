import { Suspense } from "react";
import { CreateScreen } from "../../components/create-screen";

export const metadata = { title: "Launch a coin — dao.fun" };

export default function CreatePage() {
  return (
    <Suspense fallback={<div className="card">Loading…</div>}>
      <CreateScreen />
    </Suspense>
  );
}
