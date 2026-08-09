/**
 * Chain-direct trade history — the terminal's no-backend data source.
 *
 * Every trade emits a TradeEvent as a self-CPI (inner instruction), so a
 * coin's full history is recoverable from the transactions that touched its
 * curve PDA: getSignaturesForAddress(curve) → getTransactions → decode inner
 * instructions with the SDK event codec. Incremental: the newest known
 * signature is the cursor (`until`), results are cached in localStorage, so
 * a revisit only fetches what's new. The hosted indexer (when configured)
 * replaces this wholesale — same shapes, richer data, no per-visitor RPC.
 */
import bs58 from "bs58";
import type { Connection, PublicKey } from "@solana/web3.js";
import { PublicKey as PK } from "@solana/web3.js";
import {
  aggregateCandles,
  curvePda,
  decodeLaunchpadEvent,
  type Candle,
  type TradePoint,
} from "@daofun/sdk/launchpad";
import type { TradeView } from "./launchpad-api";
import { launchpadProgramId } from "./cluster";

const CACHE_PREFIX = "daofun:trades:";
const CACHE_CAP = 2000;
const SIG_PAGE_LIMIT = 1000;
const TX_BATCH = 20;

/** The slice of a fetched transaction the decoder needs (real ones satisfy it). */
export interface TxLike {
  slot: number;
  blockTime?: number | null;
  meta: {
    err: unknown;
    innerInstructions?:
      | { index: number; instructions: { programIdIndex: number; data: string }[] }[]
      | null;
  } | null;
  transaction: {
    message: {
      accountKeys?: { toBase58(): string }[];
      staticAccountKeys?: { toBase58(): string }[];
    };
  };
}

/** Decode every launchpad trade in one transaction (usually 0 or 1). */
export function tradesFromTransaction(
  tx: TxLike,
  signature: string,
  mint: string,
  programId: PublicKey = launchpadProgramId(),
): TradeView[] {
  if (!tx.meta || tx.meta.err !== null) return [];
  const msg = tx.transaction.message;
  const keys = (msg.accountKeys ?? msg.staticAccountKeys ?? []).map((k) => k.toBase58());
  const program = programId.toBase58();
  const out: TradeView[] = [];
  for (const group of tx.meta.innerInstructions ?? []) {
    for (const ix of group.instructions) {
      if (keys[ix.programIdIndex] !== program) continue;
      let event;
      try {
        event = decodeLaunchpadEvent(bs58.decode(ix.data));
      } catch {
        continue;
      }
      if (!event || event.kind !== "trade" || event.mint.toBase58() !== mint) continue;
      out.push({
        signature,
        mint,
        trader: event.user.toBase58(),
        isBuy: event.isBuy,
        tokenAmount: event.tokenAmount.toString(),
        solAmount: event.solAmount.toString(),
        virtualSol: event.virtualSol.toString(),
        virtualToken: event.virtualToken.toString(),
        slot: tx.slot,
        blockTime: tx.blockTime ?? null,
      });
    }
  }
  return out;
}

/** Newest-first merge, deduped by signature, capped. */
export function mergeTrades(fresh: TradeView[], cached: TradeView[], cap = CACHE_CAP): TradeView[] {
  const seen = new Set<string>();
  const out: TradeView[] = [];
  for (const t of [...fresh, ...cached].sort((a, b) => b.slot - a.slot)) {
    const key = `${t.signature}:${t.trader}:${t.tokenAmount}:${t.isBuy}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

/** Trades (newest-first) → chronological candle points; unbucketable ones skipped. */
export function candlesFromTrades(trades: readonly TradeView[], resolutionSeconds: number): Candle[] {
  const points: TradePoint[] = [];
  for (let i = trades.length - 1; i >= 0; i -= 1) {
    const t = trades[i]!;
    if (t.blockTime === null) continue;
    points.push({
      blockTime: t.blockTime,
      virtualSol: BigInt(t.virtualSol),
      virtualToken: BigInt(t.virtualToken),
      solAmount: BigInt(t.solAmount),
    });
  }
  return aggregateCandles(points, resolutionSeconds);
}

interface TradeCache {
  newestSignature: string | null;
  trades: TradeView[];
}

function loadCache(mint: string): TradeCache {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + mint);
    if (raw) return JSON.parse(raw) as TradeCache;
  } catch {
    /* private mode / SSR */
  }
  return { newestSignature: null, trades: [] };
}

function saveCache(mint: string, cache: TradeCache): void {
  try {
    localStorage.setItem(CACHE_PREFIX + mint, JSON.stringify(cache));
  } catch {
    /* best-effort */
  }
}

/**
 * Fetch the coin's trade history from chain, incrementally. Returns
 * newest-first trades. A devnet reset (unknown cursor) degrades gracefully:
 * the RPC ignores an unknown `until` and returns the newest page, and the
 * merge dedupes.
 */
export async function fetchTradeHistory(connection: Connection, mint: string): Promise<TradeView[]> {
  const cache = loadCache(mint);
  const curve = curvePda(new PK(mint), launchpadProgramId());
  const infos = await connection.getSignaturesForAddress(
    curve,
    { limit: SIG_PAGE_LIMIT, ...(cache.newestSignature ? { until: cache.newestSignature } : {}) },
    "confirmed",
  );
  const sigs = infos.filter((i) => i.err === null).map((i) => i.signature);

  const fresh: TradeView[] = [];
  for (let i = 0; i < sigs.length; i += TX_BATCH) {
    const chunk = sigs.slice(i, i + TX_BATCH);
    const txs = await connection.getTransactions(chunk, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    txs.forEach((tx, j) => {
      if (tx) fresh.push(...tradesFromTransaction(tx as unknown as TxLike, chunk[j]!, mint));
    });
  }

  const merged = mergeTrades(fresh, cache.trades);
  saveCache(mint, {
    newestSignature: infos[0]?.signature ?? cache.newestSignature,
    trades: merged,
  });
  return merged;
}

export interface TradeWatch {
  stop(): void;
  /**
   * Fetch now instead of waiting for the next tick.
   *
   * A trade's author and signature only exist in the TRANSACTION, so the tape
   * cannot be served by an account subscription the way price can. But the
   * curve account changing IS the signal that a trade just landed, so the
   * caller can nudge this the moment that push arrives and the tape lands
   * about a second behind the trade instead of up to a full interval. Coalesced,
   * so a burst of pushes is one fetch.
   */
  poke(): void;
}

/**
 * Keep the trade tape fresh while the page is open. Calls `onTrades` with the
 * full newest-first list after every successful refresh.
 *
 * The interval is the floor, not the mechanism: it exists so the tape still
 * fills on an RPC that cannot push, and so a missed push cannot strand it.
 */
export function watchTrades(
  connection: Connection,
  mint: string,
  onTrades: (trades: TradeView[]) => void,
  intervalMs = 5000,
): TradeWatch {
  let live = true;
  let inFlight = false;
  let again = false;
  const tick = () => {
    if (!live || document.visibilityState === "hidden") return;
    if (inFlight) {
      again = true; // a push landed mid-fetch; do exactly one more
      return;
    }
    inFlight = true;
    fetchTradeHistory(connection, mint)
      .then((t) => live && onTrades(t))
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (live && again) {
          again = false;
          tick();
        }
      });
  };
  tick();
  const id = setInterval(tick, intervalMs);
  return {
    stop() {
      live = false;
      clearInterval(id);
    },
    poke: tick,
  };
}
