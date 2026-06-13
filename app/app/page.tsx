import Link from "next/link";
import { DaoNavigator } from "../components/dao-navigator";

/**
 * Mode selection — spec 6.7: side-by-side comparison; copy per spec 12.2.
 * Guarded is structurally unselectable until Stage 3 (no launch link).
 */
const MODES = [
  {
    id: "council",
    name: "Council",
    tagline: "Community votes, a fixed council can veto during the hold-up.",
    points: [
      "Veto set is fixed at launch (council mint, no mint authority)",
      "Council cannot pass proposals — veto power only",
      "Tier floors on quorum, hold-up, lockup",
    ],
  },
  {
    id: "cypherpunk",
    name: "Cypherpunk",
    tagline: "Code is law. No veto, irreversible.",
    points: [
      "No council mint exists — structurally no veto",
      "Tier floors still apply (hold-up is the exit window)",
      "One explicit confirmation required",
    ],
  },
  {
    id: "sovereign",
    name: "Sovereign",
    tagline: "No veto, no timelock floor. The DAO is fully self-governing.",
    points: [
      "Hold-up can be ZERO — funds can move the moment a vote passes",
      "Two explicit confirmations required",
      "Used by the mainnet GATE 1 evidence run",
    ],
  },
  {
    id: "guarded",
    name: "Guarded",
    tagline: "Proposals restricted to a fixed safe action menu.",
    points: [
      "Realm authority held by the proposal-gate program",
      "Ships at Stage 3 — not selectable yet",
    ],
  },
] as const;

export default function ModeSelectionPage() {
  return (
    <>
      <h1>Pick a governance mode</h1>
      <p className="muted">
        Mode is structural, not a setting: what a mode forbids does not
        exist on-chain. Floors only ratchet stricter after launch.
      </p>
      <div className="mode-grid">
        {MODES.map((mode) => {
          const selectable = mode.id !== "guarded";
          return (
            <div
              key={mode.id}
              className={`card${selectable ? "" : " disabled"}`}
              data-testid={`mode-card-${mode.id}`}
            >
              <h3>{mode.name}</h3>
              <p>{mode.tagline}</p>
              <ul>
                {mode.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {selectable ? (
                <Link className="button" href={`/launch/?mode=${mode.id}`}>
                  Launch {mode.name}
                </Link>
              ) : (
                <span className="muted">Available at Stage 3</span>
              )}
            </div>
          );
        })}
      </div>
      <DaoNavigator />
    </>
  );
}
