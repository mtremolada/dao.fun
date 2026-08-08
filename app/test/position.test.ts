import { describe, expect, it } from "vitest";
import { computePosition, topTraders } from "../lib/position";
import type { TradeView } from "../lib/launchpad-api";

const trade = (o: Partial<TradeView> & { slot: number }): TradeView => ({
  signature: `s${o.slot}`,
  mint: "m",
  trader: "me",
  isBuy: true,
  tokenAmount: "0",
  solAmount: "0",
  virtualSol: "1",
  virtualToken: "1",
  blockTime: o.slot,
  ...o,
});

describe("computePosition", () => {
  it("averages cost across buys and realizes PnL on sells", () => {
    const trades = [
      // 100 tokens for 1 SOL, then 100 more for 3 SOL → avg 0.02 SOL/token
      trade({ slot: 1, isBuy: true, tokenAmount: "100000000", solAmount: "1000000000" }),
      trade({ slot: 2, isBuy: true, tokenAmount: "100000000", solAmount: "3000000000" }),
      // sell half (100) for 3 SOL → basis removed 2 SOL → realized +1 SOL
      trade({ slot: 3, isBuy: false, tokenAmount: "100000000", solAmount: "3000000000" }),
    ];
    // spot: 0.03 SOL/token → 100 held tokens worth 3 SOL vs 2 SOL basis
    const p = computePosition(trades, "me", 0.03);
    expect(p.tokens).toBe(100_000_000n);
    expect(p.costLamports).toBeCloseTo(2_000_000_000, 0);
    expect(p.avgCostSolPerToken).toBeCloseTo(0.02, 9);
    expect(p.realizedLamports).toBeCloseTo(1_000_000_000, 0);
    expect(p.unrealizedLamports).toBeCloseTo(1_000_000_000, 0);
  });

  it("ignores other traders and over-sells without basis", () => {
    const trades = [
      trade({ slot: 1, trader: "other", isBuy: true, tokenAmount: "5", solAmount: "5" }),
      trade({ slot: 2, isBuy: false, tokenAmount: "100", solAmount: "100" }), // sell w/o holding
    ];
    const p = computePosition(trades, "me", 1);
    expect(p.tokens).toBe(0n);
    expect(p.realizedLamports).toBe(0);
  });
});

describe("topTraders", () => {
  it("aggregates net tokens and orders largest holders first", () => {
    const trades = [
      trade({ slot: 1, trader: "a", isBuy: true, tokenAmount: "300", solAmount: "3" }),
      trade({ slot: 2, trader: "b", isBuy: true, tokenAmount: "500", solAmount: "5" }),
      trade({ slot: 3, trader: "a", isBuy: false, tokenAmount: "100", solAmount: "1" }),
    ];
    const stats = topTraders(trades);
    expect(stats.map((s) => s.trader)).toEqual(["b", "a"]);
    expect(stats[1]).toMatchObject({ netTokens: 200n, boughtSol: 3, soldSol: 1, trades: 2 });
  });
});
