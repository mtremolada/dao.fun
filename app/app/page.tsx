import Link from "next/link";

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
    tagline: "Proposals restricted to a fixed safe action menu. Recommended.",
    points: [
      "The on-chain gate authors every proposal — off-menu never exists",
      "Community voting untouched; nothing to configure",
      "Strongest protection, simplest setup",
    ],
  },
] as const;

export default function HomePage() {
  return (
    <>
      <h1>Launch a token with a treasury that protects itself</h1>
      <p className="muted">
        One launch page, four protection levels — all on it. Protection is
        structural, not a setting: what a level forbids does not exist
        on-chain. Floors only ratchet stricter after launch.
      </p>
      <p>
        <Link className="button primary" href="/launch" data-testid="cta-launch">
          Launch — all options on one page
        </Link>
      </p>
      <div className="mode-grid">
        {MODES.map((mode) => (
          <div key={mode.id} className="card" data-testid={`mode-card-${mode.id}`}>
            <h3>{mode.name}</h3>
            <p>{mode.tagline}</p>
            <ul>
              {mode.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
