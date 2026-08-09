import Link from "next/link";

/**
 * Landing. The governance-mode comparison that used to live here is GONE:
 * every protection level now carries its own detail on /launch, so this
 * page is a signpost rather than a step in the launch funnel.
 */
const DESTINATIONS = [
  {
    href: "/board",
    name: "Board",
    tagline: "Every coin on the curve, live.",
    points: [
      "New / graduating / graduated, updating as trades land",
      "Each coin opens a full trading terminal — chart, trades, position",
    ],
    cta: "Explore the board",
  },
  {
    href: "/create",
    name: "Create a coin",
    tagline: "Fair bonding curve that graduates to Raydium.",
    points: [
      "No presale, no team allocation — the curve is the only seller",
      "At completion, liquidity migrates and the LP is burned",
    ],
    cta: "Create a coin",
  },
  {
    href: "/launch",
    name: "Launch a DAO",
    tagline: "A treasury that protects itself, with no platform keys.",
    points: [
      "Four protection levels, all on one page — Guarded is the default",
      "Protection is structural: what a level forbids cannot exist on-chain",
    ],
    cta: "Launch a DAO",
  },
] as const;

export default function HomePage() {
  return (
    <>
      <h1>Launch a coin whose treasury protects itself</h1>
      <p className="muted">
        Coins launch on a fair curve and graduate to Raydium with the LP
        burned. Governance is optional — and when you want it, protection is
        structural, not a setting: what a level forbids does not exist
        on-chain, and it only ratchets stricter after launch.
      </p>
      <p>
        <Link className="button primary" href="/launch" data-testid="cta-launch">
          Launch a DAO
        </Link>{" "}
        <Link className="button" href="/board" data-testid="cta-board">
          Explore the board
        </Link>
      </p>
      <div className="mode-grid">
        {DESTINATIONS.map((d) => (
          <div key={d.href} className="card" data-testid={`home-card-${d.name.split(" ")[0]!.toLowerCase()}`}>
            <h3>{d.name}</h3>
            <p>{d.tagline}</p>
            <ul>
              {d.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
            <Link className="button" href={d.href}>
              {d.cta}
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}
