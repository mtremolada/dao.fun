import { describe, expect, it } from "vitest";
import { aggregateCandles, spotPriceSol, type TradePoint } from "../src/launchpad/candles";

const pt = (blockTime: number, vSol: bigint, vToken: bigint, sol: bigint): TradePoint => ({
  blockTime,
  virtualSol: vSol,
  virtualToken: vToken,
  solAmount: sol,
});

describe("spotPriceSol", () => {
  it("normalizes lamports/base-units to SOL per whole token", () => {
    // 30 SOL / 1.073e9 whole tokens ≈ 2.796e-8 SOL/token
    expect(spotPriceSol(30_000_000_000n, 1_073_000_000_000_000n)).toBeCloseTo(
      30 / 1_073_000_000, 12,
    );
  });

  it("guards a zero token reserve", () => {
    expect(spotPriceSol(1n, 0n)).toBe(0);
  });
});

describe("aggregateCandles", () => {
  it("buckets by resolution with OHLC in trade order and summed volume", () => {
    const points = [
      pt(60, 30_000_000_000n, 1_000_000_000_000_000n, 1_000_000_000n), // open
      pt(70, 40_000_000_000n, 1_000_000_000_000_000n, 2_000_000_000n), // high
      pt(80, 20_000_000_000n, 1_000_000_000_000_000n, 500_000_000n), //  low
      pt(110, 35_000_000_000n, 1_000_000_000_000_000n, 250_000_000n), // close
      pt(120, 36_000_000_000n, 1_000_000_000_000_000n, 100_000_000n), // next bucket
    ];
    const candles = aggregateCandles(points, 60);
    expect(candles).toHaveLength(2);
    const [a, b] = candles;
    expect(a!.time).toBe(60);
    expect(a!.open).toBeCloseTo(spotPriceSol(30_000_000_000n, 1_000_000_000_000_000n), 15);
    expect(a!.high).toBeCloseTo(spotPriceSol(40_000_000_000n, 1_000_000_000_000_000n), 15);
    expect(a!.low).toBeCloseTo(spotPriceSol(20_000_000_000n, 1_000_000_000_000_000n), 15);
    expect(a!.close).toBeCloseTo(spotPriceSol(35_000_000_000n, 1_000_000_000_000_000n), 15);
    expect(a!.volume).toBeCloseTo(3.75, 9);
    expect(b!.time).toBe(120);
    expect(b!.volume).toBeCloseTo(0.1, 9);
  });

  it("omits empty buckets and keeps ascending time order", () => {
    const points = [
      pt(0, 1_000_000_000n, 1_000_000_000_000n, 1n),
      pt(600, 2_000_000_000n, 1_000_000_000_000n, 1n),
    ];
    const times = aggregateCandles(points, 60).map((c) => c.time);
    expect(times).toEqual([0, 600]);
  });

  it("applies the limit to the NEWEST candles", () => {
    const points = Array.from({ length: 10 }, (_, i) =>
      pt(i * 60, 1_000_000_000n, 1_000_000_000_000n, 1n),
    );
    const candles = aggregateCandles(points, 60, 3);
    expect(candles.map((c) => c.time)).toEqual([420, 480, 540]);
  });

  it("clamps a sub-second resolution to 1s", () => {
    const candles = aggregateCandles([pt(5, 1_000_000_000n, 1_000_000_000_000n, 1n)], 0);
    expect(candles[0]!.time).toBe(5);
  });
});
