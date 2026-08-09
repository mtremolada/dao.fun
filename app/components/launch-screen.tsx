"use client";

/**
 * ONE launch page (PLAN-UNIFIED-LAUNCH R2): every protection level is a
 * simple card on this page — no separate mode-picker step. Guarded is the
 * default and needs zero configuration (the protection is structural,
 * D-042); council/sovereign reveal their few inputs inline. Old
 * /launch?mode= links still land on the right card.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { LaunchForm } from "./launch-form";
import type { GovernanceMode } from "@daofun/sdk/launch-form";

const PROTECTIONS: {
  id: GovernanceMode;
  name: string;
  badge?: string;
  danger?: boolean;
  copy: string;
  /** The structural facts — this is the whole comparison, on this page. */
  points: string[];
}[] = [
  {
    id: "guarded",
    name: "Guarded",
    badge: "recommended",
    copy:
      "Proposals can only come from the safety menu — the treasury cannot be drained even by a winning vote. Nothing to configure.",
    points: [
      "An on-chain gate authors every proposal; anything off-menu cannot be created at all",
      "Anyone can propose from the menu, and your token holders vote as normal",
      "The menu covers grants, buybacks, liquidity, distributions and parameter changes",
      "Strongest protection, and the only level with nothing to fill in",
    ],
  },
  {
    id: "council",
    name: "Council",
    copy: "People you name can veto a bad proposal before it executes.",
    points: [
      "The veto set is fixed at launch — the council mint's authority is burned",
      "The council can only veto; it can never pass a proposal of its own",
      "Tier floors apply to quorum, hold-up and lockup",
    ],
  },
  {
    id: "cypherpunk",
    name: "Cypherpunk",
    copy: "Pure token voting. No veto, no council — irreversible.",
    points: [
      "No council mint exists, so there is structurally no veto",
      "The hold-up window is the only exit route once a vote passes",
      "One explicit confirmation required",
    ],
  },
  {
    id: "sovereign",
    name: "Sovereign",
    danger: true,
    copy:
      "No guardrails at all. The DAO can drain itself the moment a vote passes.",
    points: [
      "The hold-up can be ZERO — funds move the instant a vote passes",
      "No veto, no menu, no floor: nothing stands between a vote and the treasury",
      "Two explicit confirmations required",
    ],
  },
];

export function LaunchScreen() {
  const q = useSearchParams();
  const initial = PROTECTIONS.find((p) => p.id === q.get("mode"))?.id ?? "guarded";
  const [mode, setMode] = useState<GovernanceMode>(initial);
  const selected = PROTECTIONS.find((p) => p.id === mode)!;
  return (
    <>
      <h1>Launch</h1>
      <p className="muted">
        Pick a protection level — it is structural, not a setting: what a
        level forbids does not exist on-chain, and it only ever ratchets
        toward less protection by the DAO&apos;s own vote.
      </p>
      <div className="protection-row" role="radiogroup" aria-label="Protection level">
        {PROTECTIONS.map((p) => (
          <button
            key={p.id}
            role="radio"
            aria-checked={mode === p.id}
            className={`protection-card${mode === p.id ? " active" : ""}${p.danger ? " danger" : ""}`}
            onClick={() => setMode(p.id)}
            data-testid={`protection-${p.id}`}
          >
            <span className="protection-name">
              {p.name}
              {p.badge && <span className="badge" data-state="verified"> {p.badge}</span>}
            </span>
            <span className="muted small">{p.copy}</span>
          </button>
        ))}
      </div>
      <ul className="protection-detail" data-testid="protection-detail">
        {selected.points.map((point) => (
          <li key={point}>{point}</li>
        ))}
      </ul>
      <LaunchForm mode={mode} />
    </>
  );
}
