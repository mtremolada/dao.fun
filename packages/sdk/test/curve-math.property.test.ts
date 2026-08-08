/**
 * Launchpad curve math — property suite (SPEC-LAUNCHPAD.md §3).
 *
 * Written BEFORE src/curve-math.ts. The module under test is the operation-
 * order specification the Rust program mirrors instruction for instruction,
 * so an invariant proven here is an invariant the on-chain code inherits —
 * and tests/launchpad-parity.integration.test.ts (Phase 2) re-checks that
 * inheritance by running the same sequences through both.
 *
 * Randomized inputs, exact assertions: no tolerance windows on money math
 * (the house rule from the Stage 2 fuzz suite).
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DEVNET_SCALED,
  PUMP_CLASSIC,
  applyBuy,
  applySell,
  buyQuote,
  initialState,
  marketCapLamports,
  progressBps,
  raiseAtCompletion,
  sellQuote,
  tokensForSolInput,
  validateParams,
  type CurveParams,
  type CurveState,
} from "../src/curve-math";

const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

/** A state some way into its life, reached by replaying real buys. */
function stateAfterBuying(params: CurveParams, tokens: bigint): CurveState {
  let s = initialState(params);
  if (tokens > 0n) s = applyBuy(s, buyQuote(s, tokens));
  return s;
}

/** Token amounts that are always purchasable on a fresh curve. */
const arbBuyable = fc.bigInt({ min: 1n, max: PUMP_CLASSIC.initialRealToken });

describe("curve params and pinned economics", () => {
  it("derives the completion raise from the constants, not a magic number", () => {
    // Single-buy raise: ceil(R * vSol0 / (vT0 - R)). Any multi-buy path
    // rounds up more often, so this is the floor of what a curve can raise.
    const pump = raiseAtCompletion(PUMP_CLASSIC);
    const devnet = raiseAtCompletion(DEVNET_SCALED);

    // Recomputed here by hand so a silent constant edit cannot pass.
    const byHand = (p: CurveParams) => {
      const num = p.initialRealToken * p.initialVirtualSol;
      const den = p.initialVirtualToken - p.initialRealToken;
      return num % den === 0n ? num / den : num / den + 1n;
    };
    expect(pump).toBe(byHand(PUMP_CLASSIC));
    expect(devnet).toBe(byHand(DEVNET_SCALED));

    // Pinned: ~85.005 SOL production, ~2.834 SOL devnet (one faucet cycle).
    expect(pump).toBe(85_005_359_057n);
    expect(devnet).toBe(2_833_511_969n);

    // The devnet profile is the production one with virtual SOL scaled by
    // 30; everything else must be identical or the paths diverge.
    expect(PUMP_CLASSIC.initialVirtualSol / DEVNET_SCALED.initialVirtualSol).toBe(30n);
    expect(DEVNET_SCALED.initialVirtualToken).toBe(PUMP_CLASSIC.initialVirtualToken);
    expect(DEVNET_SCALED.initialRealToken).toBe(PUMP_CLASSIC.initialRealToken);
    expect(DEVNET_SCALED.tokenTotalSupply).toBe(PUMP_CLASSIC.tokenTotalSupply);
  });

  it("reserves exactly 206.9M tokens for the graduation pool", () => {
    expect(PUMP_CLASSIC.tokenTotalSupply - PUMP_CLASSIC.initialRealToken).toBe(
      206_900_000_000_000n,
    );
  });

  it("INV-GRAD-COVERS-COST: refuses params that cannot afford to graduate", () => {
    // A curve whose whole raise would not cover pool creation must never
    // accept a deposit — it could complete and then be unable to migrate.
    const overhead = 192_156_720n;
    expect(() => validateParams(PUMP_CLASSIC, overhead)).not.toThrow();
    expect(() => validateParams(DEVNET_SCALED, overhead)).not.toThrow();

    const tooSmall: CurveParams = {
      ...PUMP_CLASSIC,
      initialVirtualSol: 100_000_000n, // raise ~0.28 SOL vs 2x0.192 needed
    };
    expect(() => validateParams(tooSmall, overhead)).toThrow(
      /graduat|migration|cover/i,
    );
  });

  it("INV-FEE-FLOOR / INV-FEE-CAP: rejects fee totals outside [10, 500] bps", () => {
    for (const [protocol, creator] of [
      [0, 0],
      [5, 4],
      [400, 101],
      [600, 0],
    ] as [number, number][]) {
      expect(() =>
        validateParams(
          { ...PUMP_CLASSIC, protocolFeeBps: protocol, creatorFeeBps: creator },
          192_156_720n,
        ),
      ).toThrow(/fee/i);
    }
    // The production split sits inside the band.
    expect(PUMP_CLASSIC.protocolFeeBps + PUMP_CLASSIC.creatorFeeBps).toBe(100);
  });
});

describe("buy", () => {
  it("INV-ROUND-BUY: cost is ceil-rounded, so the pool never subsidises a buyer", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = initialState(PUMP_CLASSIC);
        const q = buyQuote(s, tokens);
        const num = q.tokensOut * s.virtualSol;
        const den = s.virtualToken - q.tokensOut;
        // cost >= exact real-valued price, and never more than 1 lamport over
        expect(q.curveCost * den >= num).toBe(true);
        expect((q.curveCost - 1n) * den < num).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("INV-K-NONDECREASING: k never falls across a buy", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = initialState(PUMP_CLASSIC);
        const after = applyBuy(s, buyQuote(s, tokens));
        expect(after.virtualSol * after.virtualToken >= s.virtualSol * s.virtualToken).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("INV-U128-WIDEN: intermediates fit u128 and results fit u64", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = initialState(PUMP_CLASSIC);
        const q = buyQuote(s, tokens);
        // The widest product the Rust mirror computes.
        expect(q.tokensOut * s.virtualSol <= U128_MAX).toBe(true);
        for (const v of [q.curveCost, q.protocolFee, q.creatorFee, q.totalCost]) {
          expect(v >= 0n).toBe(true);
          expect(v <= U64_MAX).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("INV-FEE-FLOOR: no trade is ever free", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = initialState(PUMP_CLASSIC);
        const q = buyQuote(s, tokens);
        // The invariant is that SOME fee is always charged — not that both
        // parties get a share. At a 1-lamport curve cost the whole fee is
        // one lamport and cannot be split two ways; the protocol absorbs
        // the remainder, deterministically.
        if (q.curveCost > 0n) {
          expect(q.protocolFee + q.creatorFee > 0n).toBe(true);
        }
        expect(q.protocolFee >= q.creatorFee).toBe(true);
        // Fees are charged ON TOP: the curve receives exactly curveCost.
        expect(q.totalCost).toBe(q.curveCost + q.protocolFee + q.creatorFee);
      }),
      { numRuns: 300 },
    );
  });

  it("INV-RESERVE-CAP: output clamps at the real reserve and completes the curve", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: PUMP_CLASSIC.initialRealToken * 4n }),
        (tokens) => {
          const s = initialState(PUMP_CLASSIC);
          const q = buyQuote(s, tokens);
          expect(q.tokensOut <= s.realToken).toBe(true);
          expect(q.tokensOut).toBe(tokens > s.realToken ? s.realToken : tokens);
          const after = applyBuy(s, q);
          // Completion is exactly "the real reserve hit zero", nothing else.
          expect(after.complete).toBe(after.realToken === 0n);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the buy that empties the curve raises at least the derived minimum", () => {
    // Whole curve in one buy: the pinned floor, exactly.
    const s = initialState(PUMP_CLASSIC);
    const done = applyBuy(s, buyQuote(s, PUMP_CLASSIC.initialRealToken));
    expect(done.complete).toBe(true);
    expect(done.realSol).toBe(raiseAtCompletion(PUMP_CLASSIC));
    expect(done.realToken).toBe(0n);

    // Split into many buys, every one of which rounds up: the curve keeps
    // the dust, so the raise can only be larger.
    let m = initialState(PUMP_CLASSIC);
    const chunk = PUMP_CLASSIC.initialRealToken / 97n;
    while (!m.complete) {
      m = applyBuy(m, buyQuote(m, chunk === 0n ? m.realToken : chunk));
    }
    expect(m.realSol >= raiseAtCompletion(PUMP_CLASSIC)).toBe(true);
    expect(m.realToken).toBe(0n);
  });

  it("INV-COMPLETE-MONOTONE: a completed curve refuses further trading", () => {
    const s = initialState(PUMP_CLASSIC);
    const done = applyBuy(s, buyQuote(s, PUMP_CLASSIC.initialRealToken));
    expect(() => buyQuote(done, 1n)).toThrow(/complete/i);
    expect(() => sellQuote(done, 1n)).toThrow(/complete/i);
  });

  it("rejects a zero-token buy rather than minting a free quote", () => {
    const s = initialState(PUMP_CLASSIC);
    expect(() => buyQuote(s, 0n)).toThrow(/amount/i);
  });
});

describe("sell", () => {
  it("INV-ROUND-SELL: gross proceeds are floor-rounded", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = stateAfterBuying(PUMP_CLASSIC, tokens);
        if (s.complete) return;
        const held = PUMP_CLASSIC.initialRealToken - s.realToken;
        if (held === 0n) return;
        const q = sellQuote(s, held);
        expect(q.grossSol).toBe((held * s.virtualSol) / (s.virtualToken + held));
      }),
      { numRuns: 300 },
    );
  });

  it("INV-K-NONDECREASING: k never falls across a sell", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = stateAfterBuying(PUMP_CLASSIC, tokens);
        if (s.complete) return;
        const held = PUMP_CLASSIC.initialRealToken - s.realToken;
        if (held === 0n) return;
        const after = applySell(s, held, sellQuote(s, held));
        expect(after.virtualSol * after.virtualToken >= s.virtualSol * s.virtualToken).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("INV-SELL-NO-UNDERFLOW: dust sells clamp at zero and never wrap", () => {
    fc.assert(
      fc.property(arbBuyable, fc.bigInt({ min: 1n, max: 64n }), (tokens, dust) => {
        const s = stateAfterBuying(PUMP_CLASSIC, tokens);
        if (s.complete) return;
        const held = PUMP_CLASSIC.initialRealToken - s.realToken;
        const amount = dust > held ? held : dust;
        if (amount === 0n) return;
        const q = sellQuote(s, amount);
        expect(q.netSol >= 0n).toBe(true);
        // Fees can never exceed what the curve actually paid out.
        expect(q.protocolFee + q.creatorFee <= q.grossSol).toBe(true);
        expect(q.netSol).toBe(q.grossSol - q.protocolFee - q.creatorFee);
      }),
      { numRuns: 300 },
    );
  });

  it("INV-SOL-CONSERVATION: the curve's SOL falls by exactly the gross", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = stateAfterBuying(PUMP_CLASSIC, tokens);
        if (s.complete) return;
        const held = PUMP_CLASSIC.initialRealToken - s.realToken;
        if (held === 0n) return;
        const q = sellQuote(s, held);
        const after = applySell(s, held, q);
        // Gross leaves the vault; the seller takes net, the rest is fees.
        expect(s.realSol - after.realSol).toBe(q.grossSol);
        expect(after.realToken).toBe(s.realToken + held);
        expect(after.realSol >= 0n).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("refuses a sell the curve's reserve cannot cover", () => {
    // The curve can never pay out more lamports than it holds, whatever
    // the caller claims to be returning.
    const s = stateAfterBuying(PUMP_CLASSIC, 1_000_000_000_000n);
    const held = PUMP_CLASSIC.initialRealToken - s.realToken;
    expect(() => sellQuote(s, held * 1_000n)).toThrow(/reserve|exceed/i);
  });
});

describe("round trip", () => {
  it("INV-ROUNDTRIP-NONPROFIT: buy-then-sell can never profit", () => {
    fc.assert(
      fc.property(arbBuyable, (tokens) => {
        const s = initialState(PUMP_CLASSIC);
        const buy = buyQuote(s, tokens);
        const afterBuy = applyBuy(s, buy);
        if (afterBuy.complete) return; // trading is closed, nothing to sell
        const sell = sellQuote(afterBuy, buy.tokensOut);
        // The headline invariant: what comes back out is never more than
        // what went in, fees included.
        expect(sell.netSol <= buy.totalCost).toBe(true);
        // Even ignoring fees entirely, the curve leg alone cannot profit.
        expect(sell.grossSol <= buy.curveCost).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("INV-MONOTONIC-PRICE: each successive token costs at least as much", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: PUMP_CLASSIC.initialRealToken / 4n }),
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        (position, slice) => {
          const s = stateAfterBuying(PUMP_CLASSIC, position);
          if (s.complete || s.realToken < slice * 2n) return;
          const first = buyQuote(s, slice);
          const later = buyQuote(applyBuy(s, first), slice);
          // Same quantity, further up the curve: never cheaper.
          expect(later.curveCost >= first.curveCost).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("UI helpers", () => {
  it("tokensForSolInput never quotes a buy the user cannot afford", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000n, max: 500_000_000_000n }),
        (budget) => {
          const s = initialState(PUMP_CLASSIC);
          const tokens = tokensForSolInput(s, budget);
          if (tokens === 0n) return;
          // The inversion is the panel's quote: charging more than the
          // stated budget is exactly the slippage failure users hate.
          expect(buyQuote(s, tokens).totalCost <= budget).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("progress runs 0 -> 10000 bps and market cap rises with price", () => {
    const s = initialState(PUMP_CLASSIC);
    expect(progressBps(s, PUMP_CLASSIC)).toBe(0);
    const done = applyBuy(s, buyQuote(s, PUMP_CLASSIC.initialRealToken));
    expect(progressBps(done, PUMP_CLASSIC)).toBe(10_000);

    const mid = stateAfterBuying(PUMP_CLASSIC, PUMP_CLASSIC.initialRealToken / 2n);
    const p = progressBps(mid, PUMP_CLASSIC);
    expect(p).toBeGreaterThan(4_900);
    expect(p).toBeLessThan(5_100);

    // Fully-diluted cap: virtualSol * supply / virtualToken.
    expect(marketCapLamports(s, PUMP_CLASSIC)).toBe(
      (s.virtualSol * PUMP_CLASSIC.tokenTotalSupply) / s.virtualToken,
    );
    expect(marketCapLamports(done, PUMP_CLASSIC)).toBeGreaterThan(
      marketCapLamports(s, PUMP_CLASSIC),
    );
  });
});
