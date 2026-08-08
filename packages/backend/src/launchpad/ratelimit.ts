/**
 * Per-key token bucket. Used to keep the RPC proxy and airdrop endpoints from
 * being turned into someone else's free quota. `now` is injectable so the
 * limiter is deterministic under test.
 */
export class TokenBucket {
  private state = new Map<string, { tokens: number; last: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Take one token for `key`; false when the bucket is empty. */
  take(key: string, cost = 1): boolean {
    const t = this.now();
    const s = this.state.get(key) ?? { tokens: this.capacity, last: t };
    const elapsed = (t - s.last) / 1000;
    s.tokens = Math.min(this.capacity, s.tokens + elapsed * this.refillPerSecond);
    s.last = t;
    if (s.tokens < cost) {
      this.state.set(key, s);
      return false;
    }
    s.tokens -= cost;
    this.state.set(key, s);
    return true;
  }
}

/** Fixed-window cooldown keyed by an id (per-IP / per-pubkey airdrop gates). */
export class Cooldown {
  private last = new Map<string, number>();
  private windowCount = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** True if `key` is still cooling down. */
  blocked(key: string, cooldownMs: number): boolean {
    const t = this.now();
    const prev = this.last.get(key);
    return prev !== undefined && t - prev < cooldownMs;
  }

  mark(key: string): void {
    this.last.set(key, this.now());
  }

  /** Global daily counter for a shared cap; returns the count after bumping. */
  bumpDaily(bucketKey: string, dayMs = 86_400_000): number {
    const day = Math.floor(this.now() / dayMs);
    const key = `${bucketKey}:${day}`;
    const n = (this.windowCount.get(key) ?? 0) + 1;
    this.windowCount.set(key, n);
    return n;
  }
}
