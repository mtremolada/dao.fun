/**
 * OHLCV candle aggregation over the trade stream — ONE implementation shared
 * by the backend store (server-side /candles) and the app's chain-direct
 * fallback, so the chart can never disagree with the API about a bucket.
 *
 * Price is the marginal curve price after each trade (virtualSol /
 * virtualToken), normalized to SOL per whole token: (lamports/1e9) /
 * (base/1e6) = vSol/vToken/1e3. Volume is summed SOL.
 *
 * Trade prices are POST-trade, so a bucket's own trades cannot show the move
 * INTO the bucket — every bucket therefore OPENS at the previous bucket's
 * close (high/low widened to include it). Without this, a one-trade bucket
 * collapses into a bodiless doji and the chart reads as empty. Empty buckets
 * are omitted; lightweight-charts plots by index, so the series stays
 * visually continuous and the carried-forward open preserves the movement.
 */

export interface TradePoint {
  /** Unix seconds; points without a block time cannot be bucketed. */
  blockTime: number;
  /** Post-trade virtual reserves (lamports / base units). */
  virtualSol: bigint;
  virtualToken: bigint;
  /** Gross SOL side of the trade, lamports. */
  solAmount: bigint;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** SOL per whole token from virtual reserves. */
export function spotPriceSol(virtualSol: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualSol) / Number(virtualToken) / 1000;
}

/**
 * Aggregate chronologically-ordered trade points into candles. Points must be
 * sorted oldest-first (slot then ix order); the caller owns that ordering.
 */
export function aggregateCandles(
  points: readonly TradePoint[],
  resolutionSeconds: number,
  limit = 500,
): Candle[] {
  const res = Math.max(resolutionSeconds, 1);
  const buckets = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const p of points) {
    const price = spotPriceSol(p.virtualSol, p.virtualToken);
    const vol = Number(p.solAmount) / 1e9;
    const t = Math.floor(p.blockTime / res) * res;
    const b = buckets.get(t);
    if (!b) buckets.set(t, { o: price, h: price, l: price, c: price, v: vol });
    else {
      b.h = Math.max(b.h, price);
      b.l = Math.min(b.l, price);
      b.c = price;
      b.v += vol;
    }
  }
  const ordered = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  let prevClose: number | null = null;
  for (const [, b] of ordered) {
    if (prevClose !== null) {
      b.o = prevClose;
      b.h = Math.max(b.h, prevClose);
      b.l = Math.min(b.l, prevClose);
    }
    prevClose = b.c;
  }
  return ordered
    .slice(-limit)
    .map(([time, b]) => ({ time, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}
