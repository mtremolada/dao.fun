import { LaunchForm } from "../../components/launch-form";
import type { GovernanceMode } from "@daofun/sdk/launch-form";

const SELECTABLE: GovernanceMode[] = ["council", "cypherpunk", "sovereign"];

export default async function LaunchPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  const selected = SELECTABLE.find((m) => m === mode) ?? "cypherpunk";
  return (
    <>
      <h1>Launch — {selected}</h1>
      <p className="muted">
        Floors are enforced here for convenience; the server re-validates
        with the same functions. Sub-floor values never launch.
      </p>
      <LaunchForm mode={selected} />
    </>
  );
}
