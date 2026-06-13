/**
 * Launch-form and proposal-view logic — spec 6.7. Framework-free: the
 * Next.js components render these results and the backend re-validates
 * with the same functions (client floors are convenience, server floors
 * are the contract). Mode copy lives in spec 12.4.
 */
import {
  TIER_FLOORS,
  guardedVetoPercent,
  resolveGovernanceParams,
} from "./matrix";
import type { GovernanceMode, GovernanceParams, MarketCapTier } from "./types";

// Re-exported so the frontend can import this module as a standalone
// subpath ("@daofun/sdk/launch-form") without pulling the whole barrel
// (which drags chain deps into the client bundle).
export type { GovernanceMode, GovernanceParams, MarketCapTier };

export interface LaunchFormInput {
  mode: GovernanceMode;
  tier: MarketCapTier;
  /** Token metadata for the pump create. Optional in the shared shape
   * (stub/e2e paths); the PRODUCTION server requires it for real
   * launches (validated there with the same helper). */
  metadata?: { name: string; symbol: string; uri: string };
  councilMembers?: string[]; // base58
  councilVetoThresholdPercent?: number;
  sovereignHoldUpSeconds?: number;
  /** Stricter-than-floor overrides; sub-floor values are rejected. */
  overrides?: {
    holdUpSeconds?: number;
    quorumPercent?: number;
  };
  confirmations: {
    /** Cypherpunk: "no veto, irreversible" */
    noVetoIrreversible?: boolean;
    /** Sovereign confirm #1: "no veto" */
    noVeto?: boolean;
    /** Sovereign confirm #2: "this DAO can drain itself the moment a vote passes" */
    canDrainImmediately?: boolean;
  };
}

export interface LaunchFormResult {
  ok: boolean;
  errors: string[];
  params?: GovernanceParams;
}

export interface LaunchFormOptions {
  /**
   * Unlocks Guarded mode. Production sets this ONLY after the
   * proposal-gate program is live on mainnet (D-034 operator override of
   * the GATE 3 audit precondition — recorded, not hidden). Default false:
   * guarded stays unselectable.
   */
  guardedEnabled?: boolean;
}

const MAX_COUNCIL = 10;
// Threshold resolution needs a supply; the form validates shape/floors and
// the backend resolves with the real supply at launch time.
const PLACEHOLDER_SUPPLY = 1_000_000_000n;

/** Pump metadata limits (on-chain refusal would be later and ruder). */
const MAX_NAME = 32;
const MAX_SYMBOL = 10;

export function validateTokenMetadata(
  metadata: LaunchFormInput["metadata"],
): string[] {
  const errors: string[] = [];
  if (!metadata || !metadata.name?.trim()) {
    errors.push("Token name is required.");
  } else if (metadata.name.length > MAX_NAME) {
    errors.push(`Token name must be at most ${MAX_NAME} characters.`);
  }
  if (!metadata || !metadata.symbol?.trim()) {
    errors.push("Token symbol is required.");
  } else if (metadata.symbol.length > MAX_SYMBOL) {
    errors.push(`Token symbol must be at most ${MAX_SYMBOL} characters.`);
  }
  if (!metadata || !metadata.uri?.trim()) {
    errors.push("Token metadata URI is required.");
  }
  return errors;
}

export function validateLaunchForm(
  input: LaunchFormInput,
  opts: LaunchFormOptions = {},
): LaunchFormResult {
  const errors: string[] = [];

  if (input.mode === "guarded" && !opts.guardedEnabled) {
    // The gate program + SDK ceremony are complete (D-033); the unlock is
    // tied to the proposal-gate mainnet deployment (D-034 operator
    // override of the GATE 3 audit precondition).
    errors.push(
      "Guarded mode is built (Stage 3) but not yet enabled on this deployment.",
    );
    return { ok: false, errors };
  }

  // Guarded requires a human council (spec 12.2: veto REQUIRED) — the same
  // member/veto shape as council mode, with one extra constraint: the
  // gate-seat veto arithmetic must yield an unambiguous on-chain percent.
  if (input.mode === "council" || input.mode === "guarded") {
    const members = input.councilMembers ?? [];
    if (members.length === 0 || members.length > MAX_COUNCIL) {
      errors.push(`Council needs 1..${MAX_COUNCIL} members.`);
    }
    if (new Set(members).size !== members.length) {
      errors.push("Council members must be unique.");
    }
    const veto = input.councilVetoThresholdPercent;
    if (
      veto === undefined ||
      !Number.isInteger(veto) ||
      veto <= 0 ||
      veto > 100
    ) {
      errors.push("Council veto threshold must be an integer in (0, 100].");
    } else if (
      input.mode === "guarded" &&
      members.length >= 1 &&
      members.length <= MAX_COUNCIL
    ) {
      try {
        guardedVetoPercent(members.length, veto);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  }

  if (input.mode === "cypherpunk" && !input.confirmations.noVetoIrreversible) {
    errors.push(
      'Cypherpunk requires the explicit confirmation: "no veto, irreversible".',
    );
  }

  if (input.mode === "sovereign") {
    if (!input.confirmations.noVeto || !input.confirmations.canDrainImmediately) {
      errors.push(
        "Sovereign requires BOTH confirmations (no veto; funds can move the moment a vote passes).",
      );
    }
    if (
      input.sovereignHoldUpSeconds === undefined ||
      !Number.isInteger(input.sovereignHoldUpSeconds) ||
      input.sovereignHoldUpSeconds < 0
    ) {
      errors.push("Sovereign requires an explicit hold-up of 0 or more seconds.");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  let params: GovernanceParams;
  try {
    params = resolveGovernanceParams({
      mode: input.mode,
      tier: input.tier,
      communitySupply: PLACEHOLDER_SUPPLY,
      ...(input.sovereignHoldUpSeconds !== undefined
        ? { sovereignHoldUpSeconds: input.sovereignHoldUpSeconds }
        : {}),
    });
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }

  // Overrides may only tighten. Sovereign is exempt from floors by design
  // (its hold-up was already validated above).
  const floors = TIER_FLOORS[input.tier];
  if (input.overrides && input.mode !== "sovereign") {
    const { holdUpSeconds, quorumPercent } = input.overrides;
    if (holdUpSeconds !== undefined) {
      if (holdUpSeconds < params.holdUpSeconds) {
        errors.push(
          `Hold-up ${holdUpSeconds}s is below the ${input.tier} tier floor (${params.holdUpSeconds}s).`,
        );
      } else {
        params = { ...params, holdUpSeconds };
      }
    }
    if (quorumPercent !== undefined) {
      if (quorumPercent < floors.quorumPercent) {
        errors.push(
          `Quorum ${quorumPercent}% is below the ${input.tier} tier floor (${floors.quorumPercent}%).`,
        );
      } else {
        params = { ...params, quorumPercent };
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors, params };
}

export type HashBadge = "verified" | "mismatch" | "missing";

/** INV-9 surface: artifact hash vs the hash recomputed from on-chain state. */
export function hashBadge(
  chainHash: string,
  artifactHash: string | null,
): HashBadge {
  if (artifactHash === null) return "missing";
  return chainHash === artifactHash ? "verified" : "mismatch";
}

/** INV-3 surface: execution stays disabled until the hold-up has elapsed. */
export function executeButtonState(
  nowUnixSeconds: number,
  votingCompletedAtUnixSeconds: number,
  holdUpSeconds: number,
): { enabled: boolean; remainingSeconds: number } {
  const readyAt = votingCompletedAtUnixSeconds + holdUpSeconds;
  const remaining = Math.max(0, readyAt - nowUnixSeconds);
  return { enabled: remaining === 0, remainingSeconds: remaining };
}
