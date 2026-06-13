import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Landing — hero + mode selection (spec 6.7: side-by-side comparison; copy per
 * spec 12.2). Guarded is structurally unselectable until the proposal-gate
 * program is deployed on-chain (NEXT_PUBLIC_GUARDED_ENABLED).
 */
const MODES = [
  {
    id: "council",
    name: "Council",
    icon: "shield",
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
    icon: "code",
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
    icon: "flag",
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
    icon: "lock",
    tagline: "Proposals restricted to a fixed safe action menu.",
    points: [
      "Realm authority held by the on-chain proposal-gate program",
      "Treasury can't be sent to an arbitrary address even by a winning vote",
      "Needs the gate program deployed on-chain to function",
    ],
  },
] as const;

// Guarded needs the custom proposal-gate program LIVE on this cluster. The
// ceremony + SDK + UI are complete and tested on the real binaries; this flag
// is the single switch that turns it on once the program is deployed. Until
// then it stays unselectable — picking it without the program on-chain would
// brick the DAO at the gate-init step and burn the launcher's SOL.
const GUARDED_ENABLED = process.env.NEXT_PUBLIC_GUARDED_ENABLED === "1";

function Icon({ name }: { name: string }): ReactNode {
  const common = {
    width: 20,
    height: 20,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v5c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16" />
        </svg>
      );
    case "flag":
      return (
        <svg {...common}>
          <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
        </svg>
      );
    case "lock":
      return (
        <svg {...common}>
          <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m20 6-11 11-5-5" />
        </svg>
      );
    case "scale":
      return (
        <svg {...common}>
          <path d="M12 3v18M7 21h10M5 7h14M5 7l-2.5 6a3 3 0 0 0 5 0L5 7Zm14 0-2.5 6a3 3 0 0 0 5 0L19 7Z" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default:
      return null;
  }
}

const FEATURES = [
  {
    icon: "scale",
    title: "Holder-governed treasury",
    body: "Creator fees sweep into an on-chain vault that only the token holders can move — by vote.",
  },
  {
    icon: "lock",
    title: "No platform keys",
    body: "Predicted-PDA custody from block zero. There is no human key in the custody path to trust.",
  },
  {
    icon: "eye",
    title: "Verifiable on-chain",
    body: "Every DAO's custody structure and each proposal's real effects are re-checked in your browser.",
  },
] as const;

export default function ModeSelectionPage() {
  return (
    <>
      <section className="hero">
        <span className="eyebrow">
          <span className="dot" />
          Serverless · runs on your wallet &amp; RPC
        </span>
        <h1>
          Launch a token.
          <br />
          Let the <span className="gradient-text">holders</span> own the fees.
        </h1>
        <p className="hero-sub">
          dao.fun mints a pump.fun coin whose creator fees flow straight into an
          on-chain, holder-governed treasury. No platform keys, no custodian —
          custody is a predicted PDA from the very first block.
        </p>
        <div className="hero-cta">
          <Link className="button" href="/launch?mode=cypherpunk">
            Launch a DAO
          </Link>
          <a
            className="button secondary"
            href="#modes"
          >
            Compare modes
          </a>
        </div>

        <div className="feature-strip">
          {FEATURES.map((f) => (
            <div className="feature" key={f.title}>
              <span className="ficon">
                <Icon name={f.icon} />
              </span>
              <div>
                <b>{f.title}</b>
                <span>{f.body}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="section-label" id="modes">
        <h2>Pick a governance mode</h2>
        <p>
          Mode is structural, not a setting: what a mode forbids does not exist
          on-chain. Floors only ratchet stricter after launch.
        </p>
      </div>

      <div className="mode-grid">
        {MODES.map((mode) => {
          const selectable = mode.id !== "guarded" || GUARDED_ENABLED;
          return (
            <div
              key={mode.id}
              className={`card${selectable ? "" : " disabled"}`}
              data-testid={`mode-card-${mode.id}`}
            >
              <div className="card-head">
                <span className="card-icon">
                  <Icon name={mode.icon} />
                </span>
                <h3>{mode.name}</h3>
              </div>
              <p>{mode.tagline}</p>
              <ul>
                {mode.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
              {selectable ? (
                <Link className="button" href={`/launch?mode=${mode.id}`}>
                  Launch {mode.name}
                </Link>
              ) : (
                <span className="soon-tag">
                  🔒 Gate program not yet deployed on-chain
                </span>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
