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
}[] = [
  {
    id: "guarded",
    name: "Guarded",
    badge: "recommended",
    copy:
      "Proposals can only come from the safety menu — the treasury cannot be drained even by a winning vote. Nothing to configure.",
  },
  {
    id: "council",
    name: "Council",
    copy: "People you name can veto a bad proposal before it executes.",
  },
  {
    id: "cypherpunk",
    name: "Cypherpunk",
    copy: "Pure token voting. No veto, no council — irreversible.",
  },
  {
    id: "sovereign",
    name: "Sovereign",
    danger: true,
    copy:
      "No guardrails at all. The DAO can drain itself the moment a vote passes.",
  },
];

export function LaunchScreen() {
  const q = useSearchParams();
  const initial = PROTECTIONS.find((p) => p.id === q.get("mode"))?.id ?? "guarded";
  const [mode, setMode] = useState<GovernanceMode>(initial);
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
      <LaunchForm mode={mode} />
    </>
  );
}
