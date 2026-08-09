/**
 * The priority fee's contract.
 *
 * These assert the three guards, because each one protects against a distinct
 * failure that a passing "it returns a number" test would miss entirely:
 * a spike must not drain the user, a quiet chain must not talk us into bidding
 * zero, and an RPC that refuses the method must not silently make trading
 * worse than the constant it replaced.
 *
 * The congestion sample below is the shape `getRecentPrioritizationFees`
 * actually returns: one entry per recent slot, carrying the MINIMUM fee paid
 * in that slot among transactions touching the queried accounts — which is why
 * a mostly-quiet chain is mostly zeros and why the floor exists.
 */
import { describe, expect, it, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";
import {
  ConstantFeeEstimator,
  FALLBACK_MICRO_LAMPORTS,
  RecentFeeEstimator,
  percentile,
  priorityFeeLamports,
  type PriorityFeeRpc,
} from "../lib/fees";

const CURVE = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");
const VAULT = new PublicKey("42io3su15PAvmmjsNqVbPMKcaeMzjCNDzF4nf1GNCDB6");

function rpcReturning(fees: number[]): PriorityFeeRpc & { calls: number; lastAccounts: PublicKey[] } {
  const r = {
    calls: 0,
    lastAccounts: [] as PublicKey[],
    async getRecentPrioritizationFees(config: { lockedWritableAccounts: PublicKey[] }) {
      r.calls++;
      r.lastAccounts = config.lockedWritableAccounts;
      return fees.map((prioritizationFee, i) => ({ slot: 1000 + i, prioritizationFee }));
    },
  };
  return r;
}

/** A quiet chain: most slots need nothing at all. */
const QUIET = Array.from({ length: 150 }, (_, i) => (i % 10 === 0 ? 500 : 0));
/** A launch: everyone bidding for the same accounts. */
const HOT = Array.from({ length: 150 }, (_, i) => 50_000 + i * 400);
/** A spike — the case the ceiling exists for. */
const SPIKE = Array.from({ length: 150 }, () => 900_000_000);

describe("percentile", () => {
  it("takes the nearest rank, not an interpolation", () => {
    expect(percentile([1, 2, 3, 4], 0.75)).toBe(3);
    expect(percentile([5], 0.5)).toBe(5);
    expect(percentile([], 0.9)).toBe(0);
  });
});

describe("RecentFeeEstimator", () => {
  it("prices from the accounts the transaction WRITES, not the whole chain", async () => {
    const rpc = rpcReturning(HOT);
    const est = new RecentFeeEstimator(rpc);
    await est.priorityFeeMicroLamports({ writableAccounts: [CURVE, VAULT] });
    expect(rpc.lastAccounts).toEqual([CURVE, VAULT]);
  });

  it("bids near the top of a hot market rather than the middle", async () => {
    const est = new RecentFeeEstimator(rpcReturning(HOT));
    const fee = await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] });
    // p75 of 50,000..109,600 — well above the median, and above the old
    // constant, which is the whole reason a launch used to fail to land.
    expect(fee).toBeGreaterThan(FALLBACK_MICRO_LAMPORTS);
    // nearest rank: ceil(0.75 * 150) = 113 -> index 112 -> 50,000 + 112*400.
    expect(fee).toBe(94_800);
  });

  it("holds the FLOOR on a quiet chain instead of bidding zero", async () => {
    const est = new RecentFeeEstimator(rpcReturning(QUIET), { floorMicroLamports: 1_000 });
    expect(await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] })).toBe(1_000);
  });

  it("holds the CEILING through a spike, so a fee market cannot drain a wallet", async () => {
    const est = new RecentFeeEstimator(rpcReturning(SPIKE), { ceilingMicroLamports: 2_000_000 });
    const fee = await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] });
    expect(fee).toBe(2_000_000);
    // And that ceiling is a number a human can check: at a 200k-CU trade it is
    // 0.0004 SOL, not "some micro-lamports".
    expect(priorityFeeLamports(fee, 200_000) / 1e9).toBeCloseTo(0.0004, 9);
  });

  it("escalates on retry — a rebroadcast at the same price loses the same race", async () => {
    const est = new RecentFeeEstimator(rpcReturning(HOT), { escalationPerAttempt: 2 });
    const first = await est.priorityFeeMicroLamports({ writableAccounts: [CURVE], attempt: 0 });
    const second = await est.priorityFeeMicroLamports({ writableAccounts: [CURVE], attempt: 1 });
    const third = await est.priorityFeeMicroLamports({ writableAccounts: [CURVE], attempt: 2 });
    expect(second).toBe(first * 2);
    expect(third).toBe(first * 4);
  });

  it("escalation is still bounded by the ceiling", async () => {
    const est = new RecentFeeEstimator(rpcReturning(HOT), {
      escalationPerAttempt: 10,
      ceilingMicroLamports: 150_000,
    });
    expect(
      await est.priorityFeeMicroLamports({ writableAccounts: [CURVE], attempt: 5 }),
    ).toBe(150_000);
  });

  it("falls back to the old constant when the RPC refuses the method", async () => {
    const rpc: PriorityFeeRpc = {
      async getRecentPrioritizationFees() {
        throw new Error("Method not found");
      },
    };
    const est = new RecentFeeEstimator(rpc);
    // NOT the floor: degrading below today's behaviour would be a regression
    // dressed as an upgrade.
    expect(await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] })).toBe(
      FALLBACK_MICRO_LAMPORTS,
    );
  });

  it("falls back when the RPC answers with no samples at all", async () => {
    const est = new RecentFeeEstimator(rpcReturning([]));
    expect(await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] })).toBe(
      FALLBACK_MICRO_LAMPORTS,
    );
  });

  it("caches, so a panel that re-quotes on every keystroke is still one RPC", async () => {
    vi.useFakeTimers();
    try {
      const rpc = rpcReturning(HOT);
      const est = new RecentFeeEstimator(rpc, { cacheMs: 5_000, now: () => Date.now() });
      for (let i = 0; i < 20; i++) {
        await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] });
      }
      expect(rpc.calls).toBe(1);
      vi.advanceTimersByTime(6_000);
      await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] });
      expect(rpc.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prices a different coin separately — congestion is per-account", async () => {
    const rpc = rpcReturning(HOT);
    const est = new RecentFeeEstimator(rpc);
    await est.priorityFeeMicroLamports({ writableAccounts: [CURVE] });
    await est.priorityFeeMicroLamports({ writableAccounts: [VAULT] });
    expect(rpc.calls).toBe(2);
  });

  it("never sends the RPC more accounts than it accepts", async () => {
    const rpc = rpcReturning(HOT);
    const est = new RecentFeeEstimator(rpc);
    const many = Array.from({ length: 200 }, (_, i) => {
      const b = Buffer.alloc(32);
      b.writeUInt32LE(i + 1, 0);
      return new PublicKey(b);
    });
    await est.priorityFeeMicroLamports({ writableAccounts: many });
    expect(rpc.lastAccounts).toHaveLength(128);
  });
});

describe("ConstantFeeEstimator", () => {
  it("still answers the new interface, so the fallback path is one line", async () => {
    expect(await new ConstantFeeEstimator().priorityFeeMicroLamports()).toBe(
      FALLBACK_MICRO_LAMPORTS,
    );
  });
});
