"use client";

/**
 * Launch screen — reads the chosen mode from the query string (client-side
 * so it works as a static page) and renders the shared-contract form.
 */
import { useSearchParams } from "next/navigation";
import { LaunchForm } from "./launch-form";
import type { GovernanceMode } from "@daofun/sdk/launch-form";

const GUARDED_ENABLED = process.env.NEXT_PUBLIC_GUARDED_ENABLED === "1";
const SELECTABLE: GovernanceMode[] = GUARDED_ENABLED
  ? ["council", "cypherpunk", "sovereign", "guarded"]
  : ["council", "cypherpunk", "sovereign"];

export function LaunchScreen() {
  const q = useSearchParams();
  const mode = q.get("mode");
  const selected = SELECTABLE.find((m) => m === mode) ?? "cypherpunk";
  return (
    <>
      <h1>Launch — {selected}</h1>
      <p className="muted">
        Floors are enforced client-side from the shared contract; sub-floor
        values never resolve.
      </p>
      <LaunchForm mode={selected} />
    </>
  );
}
