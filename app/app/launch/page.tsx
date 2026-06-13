"use client";

/**
 * Launch page — spec 6.7, server-less (D-033). `?mode=` picks the governance
 * mode; the form validates floors live with the same shared functions the
 * launch builders enforce, and builds + signs + submits the launch entirely
 * client-side (no backend).
 */
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { LaunchForm } from "../../components/launch-form";
import type { GovernanceMode } from "@daofun/sdk/launch-form";

const SELECTABLE: GovernanceMode[] = ["council", "cypherpunk", "sovereign"];

function LaunchInner() {
  const params = useSearchParams();
  const modeParam = params.get("mode");
  const selected = SELECTABLE.find((m) => m === modeParam) ?? "cypherpunk";
  return (
    <>
      <h1>Launch — {selected}</h1>
      <p className="muted">
        Floors are enforced here with the same functions the on-chain builders
        use; sub-floor values never launch. The launch is built, signed, and
        submitted in your browser — no server ever holds a key.
      </p>
      <LaunchForm mode={selected} />
    </>
  );
}

export default function LaunchPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <LaunchInner />
    </Suspense>
  );
}
