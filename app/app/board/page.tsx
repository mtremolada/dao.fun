import { Suspense } from "react";
import { BoardScreen } from "../../components/board-screen";

export const metadata = { title: "Board — dao.fun" };

export default function BoardPage() {
  return (
    <Suspense fallback={<div className="card">Loading the board…</div>}>
      <BoardScreen />
    </Suspense>
  );
}
