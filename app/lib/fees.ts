/**
 * Priority-fee estimation.
 *
 * A priority fee buys block space when block space is contested. The failure
 * mode that matters is not paying too much — it is a trade that does not land
 * during a launch, which is precisely when the chain is busy and precisely
 * when the user cares. A constant fee is wrong in both directions: it
 * overpays on a quiet chain and underbids exactly when bidding matters.
 *
 * `RecentFeeEstimator` samples what the chain actually charged recently FOR
 * THE ACCOUNTS THIS TRANSACTION WRITES. That last part is the whole point:
 * congestion is per-account, and the fee to touch a hot coin's curve has
 * nothing to do with the fee to touch a quiet one.
 *
 * Three guards, each protecting against a different way this goes wrong:
 *
 *  - a **ceiling**, because a fee market spike must never quietly drain a
 *    user's wallet on their behalf;
 *  - a **floor**, because `getRecentPrioritizationFees` reports the MINIMUM
 *    fee per slot and a quiet chain reports a lot of zeros — bidding zero is
 *    how you sit unconfirmed the moment the chain wakes up;
 *  - a **fallback to the old constant**, because not every RPC serves this
 *    method, and degrading to something cheaper than today's behaviour would
 *    be a regression wearing the costume of an upgrade.
 */
import type { PublicKey } from "@solana/web3.js";

/** What the estimator is being asked to price. */
export interface FeeContext {
  /**
   * The accounts the transaction locks for WRITING. Congestion is per-account:
   * these are what the fee is actually competing for.
   */
  writableAccounts?: PublicKey[];
  /**
   * 0 for a first attempt, 1 for the first retry, and so on. A rebroadcast at
   * the same price is a rebroadcast that loses the same auction again.
   */
  attempt?: number;
}

export interface FeeEstimator {
  /** Micro-lamports per compute unit. */
  priorityFeeMicroLamports(ctx?: FeeContext): Promise<number>;
}

/** The default when nothing better is known — the historical behaviour. */
export const FALLBACK_MICRO_LAMPORTS = 10_000;

export class ConstantFeeEstimator implements FeeEstimator {
  constructor(private readonly microLamports = FALLBACK_MICRO_LAMPORTS) {}
  async priorityFeeMicroLamports(): Promise<number> {
    return this.microLamports;
  }
}

/** The slice of web3's Connection this needs; a real Connection satisfies it. */
export interface PriorityFeeRpc {
  getRecentPrioritizationFees(config: {
    lockedWritableAccounts: PublicKey[];
  }): Promise<{ slot: number; prioritizationFee: number }[]>;
}

export interface RecentFeeOptions {
  /** Never bid less than this. */
  floorMicroLamports?: number;
  /**
   * Never bid more than this, no matter what the samples or the retry
   * escalation say. At a 200k-CU trade the default is ~0.0004 SOL.
   */
  ceilingMicroLamports?: number;
  /** Which sample to take, 0..1. High, because the median loses races. */
  percentile?: number;
  /** How long one sample is reused, so a burst of quotes is one RPC call. */
  cacheMs?: number;
  /** Multiplier per retry. */
  escalationPerAttempt?: number;
  /** Used when the RPC has no samples or refuses the method. */
  fallbackMicroLamports?: number;
  now?: () => number;
}

const DEFAULTS = {
  floorMicroLamports: 1_000,
  ceilingMicroLamports: 2_000_000,
  percentile: 0.75,
  cacheMs: 5_000,
  escalationPerAttempt: 1.8,
  fallbackMicroLamports: FALLBACK_MICRO_LAMPORTS,
};

/**
 * The RPC caps `lockedWritableAccounts` at 128 entries and rejects the call
 * outright above it. Our transactions are far smaller, but the cap belongs
 * here rather than in a comment at the call site.
 */
const MAX_SAMPLED_ACCOUNTS = 128;

export class RecentFeeEstimator implements FeeEstimator {
  private readonly o: Required<RecentFeeOptions>;
  private cache = new Map<string, { at: number; value: number }>();

  constructor(
    private readonly rpc: PriorityFeeRpc,
    opts: RecentFeeOptions = {},
  ) {
    this.o = { ...DEFAULTS, now: () => Date.now(), ...opts };
  }

  async priorityFeeMicroLamports(ctx: FeeContext = {}): Promise<number> {
    const accounts = (ctx.writableAccounts ?? []).slice(0, MAX_SAMPLED_ACCOUNTS);
    const base = await this.sample(accounts);
    // Escalation is applied AFTER the cache, so a retry re-prices without
    // costing another RPC round trip — and so the cached sample stays the
    // honest observation rather than one attempt's inflated view of it.
    const attempt = Math.max(0, ctx.attempt ?? 0);
    const escalated = base * this.o.escalationPerAttempt ** attempt;
    return Math.round(
      Math.min(this.o.ceilingMicroLamports, Math.max(this.o.floorMicroLamports, escalated)),
    );
  }

  private async sample(accounts: PublicKey[]): Promise<number> {
    const key = accounts.map((a) => a.toBase58()).sort().join(",");
    const hit = this.cache.get(key);
    const now = this.o.now();
    if (hit && now - hit.at < this.o.cacheMs) return hit.value;

    let value: number;
    try {
      const fees = await this.rpc.getRecentPrioritizationFees({
        lockedWritableAccounts: accounts,
      });
      value = fees.length === 0 ? this.o.fallbackMicroLamports : percentile(
        fees.map((f) => f.prioritizationFee),
        this.o.percentile,
      );
    } catch {
      // An RPC that does not serve the method must not make trading worse
      // than it was before this class existed.
      value = this.o.fallbackMicroLamports;
    }
    this.cache.set(key, { at: now, value });
    return value;
  }
}

/**
 * One estimator per connection, so the sample cache survives between sends
 * instead of being rebuilt (and re-fetched) for every trade. Keyed weakly:
 * a discarded Connection takes its estimator with it.
 */
const estimators = new WeakMap<object, RecentFeeEstimator>();

export function feeEstimatorFor(rpc: PriorityFeeRpc): FeeEstimator {
  const key = rpc as unknown as object;
  const cached = estimators.get(key);
  if (cached) return cached;
  const made = new RecentFeeEstimator(rpc);
  estimators.set(key, made);
  return made;
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

/**
 * What a priority fee actually costs, so the UI can say it in SOL rather than
 * in micro-lamports per compute unit, which means nothing to anyone.
 */
export function priorityFeeLamports(microLamports: number, computeUnits: number): number {
  return Math.ceil((microLamports * computeUnits) / 1_000_000);
}
