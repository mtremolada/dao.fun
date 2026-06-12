/**
 * Anti-capture tiers and the mode x tier resolution rule — spec Section 5.
 *
 * Mode decides the capability surface and whether a vetoer exists; tier
 * decides numeric floors. Cypherpunk hold-up = max(24h, tier floor); Council
 * = tier floor; Sovereign = explicitly configured value >= 0 (exempt from
 * floors, double-confirmed in the UI); Guarded ships at Stage 3.
 */
import type { GovernanceMode, GovernanceParams, MarketCapTier } from "./types";

const HOUR = 3600;
const DAY = 86400;

export interface TierFloors {
  effectiveMinLockupSeconds: number; // UI/SDK floor — see spec 6.3 VSR note
  lockupSaturationSeconds: number;
  quorumPercent: number;
  proposalThresholdSupplyBps: number; // 200 = 2% of supply
  holdUpFloorSeconds: number;
}

export const TIER_FLOORS: Record<MarketCapTier, TierFloors> = {
  micro: {
    effectiveMinLockupSeconds: 30 * DAY,
    lockupSaturationSeconds: 365 * DAY,
    quorumPercent: 25,
    proposalThresholdSupplyBps: 200,
    holdUpFloorSeconds: 72 * HOUR,
  },
  small: {
    effectiveMinLockupSeconds: 14 * DAY,
    lockupSaturationSeconds: 365 * DAY,
    quorumPercent: 20,
    proposalThresholdSupplyBps: 100,
    holdUpFloorSeconds: 48 * HOUR,
  },
  mid: {
    effectiveMinLockupSeconds: 7 * DAY,
    lockupSaturationSeconds: 180 * DAY,
    quorumPercent: 15,
    proposalThresholdSupplyBps: 50,
    holdUpFloorSeconds: 36 * HOUR,
  },
  large: {
    effectiveMinLockupSeconds: 3 * DAY,
    lockupSaturationSeconds: 90 * DAY,
    quorumPercent: 10,
    proposalThresholdSupplyBps: 25,
    holdUpFloorSeconds: 24 * HOUR,
  },
};

const CYPHERPUNK_MIN_HOLDUP = 24 * HOUR;

/**
 * Mode-resolved hold-up floor (the Section 5 resolution rule), shared by
 * resolveGovernanceParams and the setParam floor checks: council = tier
 * floor; cypherpunk = max(24h, tier floor); sovereign = 0 (exempt by
 * explicit, double-confirmed choice).
 */
export function holdUpFloorSeconds(
  mode: GovernanceMode,
  tier: MarketCapTier,
): number {
  const floor = TIER_FLOORS[tier].holdUpFloorSeconds;
  switch (mode) {
    case "council":
      return floor;
    case "cypherpunk":
      return Math.max(CYPHERPUNK_MIN_HOLDUP, floor);
    case "sovereign":
      return 0;
    case "guarded":
      // Spec 12.2: tier floor at maximum strictness.
      return floor;
  }
}

export interface ResolveParams {
  mode: GovernanceMode;
  tier: MarketCapTier;
  /** Community token supply in base units, for the proposal threshold. */
  communitySupply: bigint;
  /** Required iff mode == "sovereign"; >= 0 (0 means no delay, by choice). */
  sovereignHoldUpSeconds?: number;
}

export function resolveGovernanceParams(p: ResolveParams): GovernanceParams {
  const floors = TIER_FLOORS[p.tier];

  let holdUpSeconds: number;
  let vetoEnabled: boolean;
  switch (p.mode) {
    case "council":
      holdUpSeconds = holdUpFloorSeconds("council", p.tier);
      vetoEnabled = true;
      break;
    case "cypherpunk":
      holdUpSeconds = holdUpFloorSeconds("cypherpunk", p.tier);
      vetoEnabled = false;
      break;
    case "sovereign":
      if (
        p.sovereignHoldUpSeconds === undefined ||
        !Number.isInteger(p.sovereignHoldUpSeconds) ||
        p.sovereignHoldUpSeconds < 0
      ) {
        throw new Error(
          "sovereign mode requires explicit sovereignHoldUpSeconds >= 0 (double-confirmed)",
        );
      }
      holdUpSeconds = p.sovereignHoldUpSeconds;
      vetoEnabled = false;
      break;
    case "guarded":
      // Spec 12.2: strictest hold-up, veto REQUIRED (the human council
      // keeps the veto while the gate holds the creation seat — D-033).
      holdUpSeconds = holdUpFloorSeconds("guarded", p.tier);
      vetoEnabled = true;
      break;
  }

  // Checked math (INV-6): bigint ops cannot overflow; guard against a zero
  // threshold that would let anyone propose on dust supplies.
  const rawThreshold =
    (p.communitySupply * BigInt(floors.proposalThresholdSupplyBps)) / 10_000n;
  const proposalThresholdTokens = rawThreshold > 0n ? rawThreshold : 1n;

  return {
    lockupSaturationSeconds: floors.lockupSaturationSeconds,
    quorumPercent: floors.quorumPercent,
    proposalThresholdTokens,
    holdUpSeconds,
    vetoEnabled,
  };
}
