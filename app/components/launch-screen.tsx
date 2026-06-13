"use client";

/**
 * Launch screen — reads the chosen mode from the query string (client-side
 * so it works as a static page) and renders the shared-contract form.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LaunchForm } from "./launch-form";
import type { GovernanceMode } from "@daofun/sdk/launch-form";

const GUARDED_ENABLED = process.env.NEXT_PUBLIC_GUARDED_ENABLED === "1";
const SELECTABLE: GovernanceMode[] = GUARDED_ENABLED
  ? ["council", "cypherpunk", "sovereign", "guarded"]
  : ["council", "cypherpunk", "sovereign"];

const MODE_BLURB: Record<GovernanceMode, string> = {
  council: "Holders vote; a fixed council can veto during the hold-up window.",
  cypherpunk: "Code is law — no veto, irreversible once a vote passes the hold-up.",
  sovereign: "No veto and no timelock floor — the DAO is fully self-governing.",
  guarded: "Proposals are restricted to a fixed, safe on-chain action menu.",
};

export function LaunchScreen() {
  const q = useSearchParams();
  const mode = q.get("mode");
  const selected = SELECTABLE.find((m) => m === mode) ?? "cypherpunk";
  return (
    <>
      <p className="muted" style={{ marginBottom: "0.5rem" }}>
        <Link href="/" style={{ color: "var(--muted)", textDecoration: "none" }}>
          ← All modes
        </Link>
      </p>
      <h1>
        Launch a <span className="gradient-text">{selected}</span> DAO
      </h1>
      <p className="hero-sub" style={{ marginBottom: "1.5rem" }}>
        {MODE_BLURB[selected]} Governance settings below are sliders bounded to
        the valid range — sub-floor values are structurally unreachable.
      </p>
      <LaunchForm mode={selected} />
    </>
  );
}
