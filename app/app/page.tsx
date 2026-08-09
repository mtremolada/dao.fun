import { BoardScreen } from "../components/board-screen";

/**
 * The board IS the front page — the market is what you land on, and
 * everything else (create, a coin's terminal) is one click from here.
 * /board renders the same screen so older links keep working.
 */
export default function HomePage() {
  return <BoardScreen />;
}
