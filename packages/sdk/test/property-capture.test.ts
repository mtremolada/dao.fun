/**
 * Section 5 property obligation (GATE 2): "for randomized (supply, price,
 * attacker budget), no buy -> lock -> propose -> drain sequence completes
 * within the lockup + hold-up window at any tier/mode combination shipped.
 * The Beanstalk pattern (vote and execute in one transaction) must be
 * structurally impossible everywhere except explicitly-configured
 * Sovereign hold-up-0, which is out-of-warranty by design."
 *
 * The model is the REAL code, not prose:
 *  - governance numbers come from resolveGovernanceParams (the same
 *    function the launch flow uses);
 *  - vote weight is the VSR baseline-0 formula `amount * min(L, sat)/sat`
 *    — verified ON-CHAIN by the GATE 1 VSR leg (unlocked == zero weight,
 *    cliff weight decays with the clock);
 *  - timing facts (tipping Disabled, finalize only after baseVotingTime,
 *    execution only after hold-up) are verified on the real binary by the
 *    GATE 1 matrix; here they parameterize the drain-time arithmetic.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  TIER_FLOORS,
  holdUpFloorSeconds,
  resolveGovernanceParams,
} from "../src/matrix";
import { MIN_BASE_VOTING_TIME_S } from "../src/actions";
import type { GovernanceMode, MarketCapTier } from "../src/types";

const U64_MAX = 2n ** 64n - 1n;
const SHIPPED_MODES: GovernanceMode[] = ["council", "cypherpunk"];
const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];

/** VSR baseline-0 voting weight (on-chain-verified formula, GATE 1). */
function vsrWeight(amount: bigint, lockupSecs: bigint, satSecs: bigint): bigint {
  const effective = lockupSecs < satSecs ? lockupSecs : satSecs;
  return (amount * effective) / satSecs;
}

/** Smallest lockup that reaches `needed` weight with `amount` tokens, or
 *  null when even full saturation cannot (capture impossible). */
function minLockupFor(amount: bigint, needed: bigint, satSecs: bigint): bigint | null {
  if (amount <= 0n || needed <= 0n) return needed <= 0n ? 0n : null;
  if (vsrWeight(amount, satSecs, satSecs) < needed) return null;
  // ceil(needed * sat / amount)
  return (needed * satSecs + amount - 1n) / amount;
}

const arbMode = fc.constantFrom(...SHIPPED_MODES);
const arbTier = fc.constantFrom(...TIERS);
const arbSupply = fc.bigInt({ min: 1_000_000n, max: U64_MAX });

describe("Section 5 capture property (shipped modes x tiers)", () => {
  it("unlocked deposits carry ZERO weight for any amount (the entry gate)", () => {
    fc.assert(
      fc.property(arbSupply, arbTier, (amount, tier) => {
        const sat = BigInt(TIER_FLOORS[tier].lockupSaturationSeconds);
        expect(vsrWeight(amount, 0n, sat)).toBe(0n);
      }),
      { numRuns: 200 },
    );
  });

  it("Beanstalk impossibility: time-to-drain is strictly positive in every shipped combo (vote+execute in one tx cannot exist)", () => {
    for (const mode of SHIPPED_MODES) {
      for (const tier of TIERS) {
        const p = resolveGovernanceParams({
          mode,
          tier,
          communitySupply: 1_000_000n,
        });
        // even at the program-minimum voting window a proposal cannot
        // finalize and execute in the same transaction
        const drainSeconds = MIN_BASE_VOTING_TIME_S + p.holdUpSeconds;
        expect(p.holdUpSeconds).toBeGreaterThanOrEqual(24 * 3600);
        expect(drainSeconds).toBeGreaterThan(0);
      }
    }
  });

  it("no profitable hit-and-run (dichotomy theorem): either the attacker is still locked when the drain lands, or the community had >= sat*quorum/100 of public notice", () => {
    // Why a dichotomy: the minimum lockup for quorum is
    //   L >= needed*sat/A >= sat*q/100   (since A <= supply),
    // so whenever the drain is FAST (drain < L) the attacker's capital is
    // still locked at execution — no dump before the damage lands. And
    // whenever the lockup could expire first (drain >= L), the drain
    // itself took >= sat*q/100 — days-to-months of PUBLIC notice (the
    // proposal is on-chain from creation and tipping is Disabled), which
    // only happens if the DAO voted itself an extremely long window.
    fc.assert(
      fc.property(
        arbMode,
        arbTier,
        arbSupply,
        // attacker holds a random fraction of supply (in bps, 1..10000)
        fc.bigInt({ min: 1n, max: 10_000n }),
        // voting window: anything a setParam vote could reach (>= program min)
        fc.integer({ min: MIN_BASE_VOTING_TIME_S, max: 60 * 86400 }),
        (mode, tier, supply, attackerBps, baseVotingTime) => {
          const params = resolveGovernanceParams({
            mode,
            tier,
            communitySupply: supply,
          });
          const floors = TIER_FLOORS[tier];
          const sat = BigInt(floors.lockupSaturationSeconds);
          const attacker = (supply * attackerBps) / 10_000n;

          // weight needed to pass: quorum% of max voter weight (the realm
          // uses FULL_SUPPLY_FRACTION, so max weight == supply at full lock)
          const needed =
            (supply * BigInt(floors.quorumPercent) + 99n) / 100n;

          // ...and to even propose, threshold weight (always positive)
          expect(params.proposalThresholdTokens > 0n).toBe(true);

          const lockup = minLockupFor(attacker, needed, sat);
          const drainSeconds =
            BigInt(baseVotingTime) +
            BigInt(holdUpFloorSeconds(mode, tier));

          if (lockup === null) {
            // budget below quorum even at full saturation: no capture path
            expect(vsrWeight(attacker, sat, sat) < needed).toBe(true);
            return;
          }
          const noticeFloor = (sat * BigInt(floors.quorumPercent)) / 100n;
          // the closed-form lower bound on committed capital time
          expect(lockup >= noticeFloor).toBe(true);
          // the dichotomy: locked-through-drain OR notice >= the floor
          expect(lockup > drainSeconds || drainSeconds >= noticeFloor).toBe(
            true,
          );
          // and at the SHIPPED voting window (D-012: 3 days) the fast arm
          // always holds — the attacker is locked through the drain
          const shippedDrain =
            BigInt(3 * 86400) + BigInt(holdUpFloorSeconds(mode, tier));
          expect(lockup > shippedDrain).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the worst shipped combo still leaves days of margin (pin the numbers)", () => {
    // large tier is the loosest: sat 90d, quorum 10% -> 9d minimum lockup
    // vs. a drain of (program-min 1h voting) + 24h hold-up ~ 25h.
    const sat = BigInt(TIER_FLOORS.large.lockupSaturationSeconds);
    const minLockup = (sat * BigInt(TIER_FLOORS.large.quorumPercent)) / 100n;
    const worstDrain = BigInt(
      MIN_BASE_VOTING_TIME_S + holdUpFloorSeconds("council", "large"),
    );
    expect(minLockup).toBe(BigInt(9 * 86400));
    expect(worstDrain).toBe(BigInt(3600 + 24 * 3600));
    expect(minLockup / worstDrain >= 8n).toBe(true); // ~8.6x margin
  });

  it("sovereign hold-up 0 is the ONLY combo where the window can vanish, and it requires the explicit double-confirmed choice", () => {
    expect(() =>
      resolveGovernanceParams({
        mode: "sovereign",
        tier: "micro",
        communitySupply: 1_000_000n,
      }),
    ).toThrow(/double-confirmed/);
    const p = resolveGovernanceParams({
      mode: "sovereign",
      tier: "micro",
      communitySupply: 1_000_000n,
      sovereignHoldUpSeconds: 0,
    });
    expect(p.holdUpSeconds).toBe(0); // out-of-warranty by design (spec 12.2)
  });
});
