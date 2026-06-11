/**
 * Spec Section 5 — anti-capture tiers and the mode x tier resolution rule.
 * Written before implementation.
 */
import { describe, expect, it } from "vitest";
import { resolveGovernanceParams, TIER_FLOORS } from "../src/matrix";
import type { MarketCapTier } from "../src/types";

const HOUR = 3600;
const DAY = 86400;
const tiers: MarketCapTier[] = ["micro", "small", "mid", "large"];

describe("tier floors (spec Section 5 table)", () => {
  it("pins the numeric floor table", () => {
    expect(TIER_FLOORS.micro).toEqual({
      effectiveMinLockupSeconds: 30 * DAY,
      lockupSaturationSeconds: 365 * DAY,
      quorumPercent: 25,
      proposalThresholdSupplyBps: 200,
      holdUpFloorSeconds: 72 * HOUR,
    });
    expect(TIER_FLOORS.small.holdUpFloorSeconds).toBe(48 * HOUR);
    expect(TIER_FLOORS.mid).toEqual({
      effectiveMinLockupSeconds: 7 * DAY,
      lockupSaturationSeconds: 180 * DAY,
      quorumPercent: 15,
      proposalThresholdSupplyBps: 50,
      holdUpFloorSeconds: 36 * HOUR,
    });
    expect(TIER_FLOORS.large.quorumPercent).toBe(10);
    expect(TIER_FLOORS.large.proposalThresholdSupplyBps).toBe(25);
  });
});

describe("resolution rule: mode -> veto/surface, tier -> floors", () => {
  const supply = 1_000_000_000n;

  it("council: hold-up == tier floor; veto structurally enabled", () => {
    for (const tier of tiers) {
      const p = resolveGovernanceParams({
        mode: "council",
        tier,
        communitySupply: supply,
      });
      expect(p.holdUpSeconds).toBe(TIER_FLOORS[tier].holdUpFloorSeconds);
      expect(p.vetoEnabled).toBe(true);
    }
  });

  it("cypherpunk: hold-up == max(24h, tier floor); no veto", () => {
    // micro floor 72h > 24h -> 72h; large floor 24h -> 24h
    expect(
      resolveGovernanceParams({ mode: "cypherpunk", tier: "micro", communitySupply: supply })
        .holdUpSeconds,
    ).toBe(72 * HOUR);
    expect(
      resolveGovernanceParams({ mode: "cypherpunk", tier: "large", communitySupply: supply })
        .holdUpSeconds,
    ).toBe(24 * HOUR);
    expect(
      resolveGovernanceParams({ mode: "cypherpunk", tier: "large", communitySupply: supply })
        .vetoEnabled,
    ).toBe(false);
  });

  it("sovereign: configured hold-up >= 0 wins, exempt from floors; requires explicit value", () => {
    const p = resolveGovernanceParams({
      mode: "sovereign",
      tier: "micro",
      communitySupply: supply,
      sovereignHoldUpSeconds: 0,
    });
    expect(p.holdUpSeconds).toBe(0);
    expect(p.vetoEnabled).toBe(false);

    expect(() =>
      resolveGovernanceParams({ mode: "sovereign", tier: "micro", communitySupply: supply }),
    ).toThrow(/sovereignHoldUpSeconds/);
    expect(() =>
      resolveGovernanceParams({
        mode: "sovereign",
        tier: "micro",
        communitySupply: supply,
        sovereignHoldUpSeconds: -1,
      }),
    ).toThrow(/sovereignHoldUpSeconds/);
  });

  it("guarded: unavailable before Stage 3", () => {
    expect(() =>
      resolveGovernanceParams({ mode: "guarded", tier: "micro", communitySupply: supply }),
    ).toThrow(/Stage 3/);
  });

  it("proposal threshold = supply * bps / 10000 with checked math (INV-6)", () => {
    const p = resolveGovernanceParams({
      mode: "council",
      tier: "micro",
      communitySupply: 1_000_000_000n,
    });
    expect(p.proposalThresholdTokens).toBe(20_000_000n); // 2% of 1B
    const tiny = resolveGovernanceParams({
      mode: "council",
      tier: "large",
      communitySupply: 1n,
    });
    expect(tiny.proposalThresholdTokens).toBe(1n); // floor would be 0 -> min 1
  });

  it("quorum and lockup saturation come from the tier", () => {
    const p = resolveGovernanceParams({
      mode: "cypherpunk",
      tier: "mid",
      communitySupply: supply,
    });
    expect(p.quorumPercent).toBe(15);
    expect(p.lockupSaturationSeconds).toBe(180 * DAY);
  });
});
