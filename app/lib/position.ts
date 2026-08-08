/**
 * Position + PnL derived from the coin's trade history (average-cost basis),
 * and the "top traders" aggregation for the activity tab. Pure functions —
 * the terminal recomputes them on every trades refresh.
 *
 * Honest scope: pre-graduation, EVERY transfer of the token is a curve trade,
 * so history-derived positions are exact. Post-graduation (AMM + free
 * transfers) they become "activity on this curve", and the UI labels them so.
 */
import type { TradeView } from "./launchpad-api";

export interface Position {
  /** Net tokens held, base units (6 decimals). */
  tokens: bigint;
  /** Cost basis of the held tokens, lamports (average-cost method). */
  costLamports: number;
  /** Average cost, SOL per whole token. */
  avgCostSolPerToken: number;
  /** Realized PnL from sells, lamports. */
  realizedLamports: number;
  /** Unrealized PnL at the given spot price, lamports. */
  unrealizedLamports: number;
}

/**
 * Fold a trader's trades (any order; sorted internally oldest-first) into a
 * position. `spotSolPerToken` is the current marginal price (SOL per whole
 * token) used for the unrealized leg.
 */
export function computePosition(
  trades: readonly TradeView[],
  trader: string,
  spotSolPerToken: number,
): Position {
  const mine = trades
    .filter((t) => t.trader === trader)
    .sort((a, b) => a.slot - b.slot);
  let tokens = 0n;
  let cost = 0; // lamports
  let realized = 0;
  for (const t of mine) {
    const amount = BigInt(t.tokenAmount);
    const sol = Number(t.solAmount);
    if (t.isBuy) {
      tokens += amount;
      cost += sol;
    } else {
      const held = Number(tokens);
      if (held <= 0) continue; // external tokens sold — no basis to attribute
      const sold = Number(amount > tokens ? tokens : amount);
      const removedCost = (cost * sold) / held;
      realized += sol - removedCost;
      cost -= removedCost;
      tokens -= amount > tokens ? tokens : amount;
    }
  }
  const wholeTokens = Number(tokens) / 1e6;
  const value = wholeTokens * spotSolPerToken * 1e9; // lamports
  return {
    tokens,
    costLamports: cost,
    avgCostSolPerToken: wholeTokens > 0 ? cost / 1e9 / wholeTokens : 0,
    realizedLamports: realized,
    unrealizedLamports: tokens > 0n ? value - cost : 0,
  };
}

export interface TraderStat {
  trader: string;
  /** Net tokens (bought − sold), base units; can be negative. */
  netTokens: bigint;
  boughtSol: number; // lamports
  soldSol: number; // lamports
  trades: number;
}

/** Aggregate per-trader activity, largest net holders first. */
export function topTraders(trades: readonly TradeView[], limit = 10): TraderStat[] {
  const byTrader = new Map<string, TraderStat>();
  for (const t of trades) {
    const s =
      byTrader.get(t.trader) ??
      { trader: t.trader, netTokens: 0n, boughtSol: 0, soldSol: 0, trades: 0 };
    const amount = BigInt(t.tokenAmount);
    if (t.isBuy) {
      s.netTokens += amount;
      s.boughtSol += Number(t.solAmount);
    } else {
      s.netTokens -= amount;
      s.soldSol += Number(t.solAmount);
    }
    s.trades += 1;
    byTrader.set(t.trader, s);
  }
  return [...byTrader.values()]
    .sort((a, b) => (b.netTokens > a.netTokens ? 1 : b.netTokens < a.netTokens ? -1 : 0))
    .slice(0, limit);
}
