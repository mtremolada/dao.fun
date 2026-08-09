/**
 * Launchpad indexer. Polls the program's transaction history, decodes the
 * emit_cpi events, and folds them into the store. Two deliberate choices,
 * both from D-026 / SPEC-LAUNCHPAD:
 *
 *  - Polling behind an injected `TxSource`, not a websocket: public-RPC
 *    websockets and getProgramAccounts are hostile from datacenter IPs, and a
 *    cursor+poll loop is resumable, idempotent, and hermetically testable. The
 *    seam means a Helius/Geyser upgrade is a drop-in.
 *  - Idempotent by (signature, ix_index): re-scanning after a restart or a
 *    devnet rollback re-applies the same rows harmlessly, so the loop can
 *    always over-fetch to be safe.
 */
import {
  decodeLaunchpadEvent,
  type LaunchpadEvent,
} from "@daofun/sdk";
import type { SqliteLaunchpadStore } from "./store";

/** One transaction, already reduced to the event blobs our program emitted. */
export interface FetchedTransaction {
  signature: string;
  slot: number;
  blockTime: number | null;
  /** Inner-instruction data blobs whose program is the launchpad, in order. */
  eventDatas: Buffer[];
}

export interface SignatureRef {
  signature: string;
  slot: number;
}

/**
 * The RPC seam. The production implementation wraps a web3 Connection; tests
 * pass a fake. `fetchSignatures` returns signatures NEWER than `afterSignature`,
 * newest-first (getSignaturesForAddress semantics).
 */
export interface TxSource {
  fetchSignatures(afterSignature: string | null, limit: number): Promise<SignatureRef[]>;
  fetchTransaction(signature: string): Promise<FetchedTransaction | null>;
}

export type IndexerSink = (event: LaunchpadEvent, ctx: { signature: string; slot: number }) => void;

export interface IndexerOptions {
  store: SqliteLaunchpadStore;
  source: TxSource;
  /** Notified for every decoded event, e.g. to fan out over SSE. */
  sink?: IndexerSink;
  /** Max signatures pulled per tick. */
  pageLimit?: number;
  /**
   * How many transaction fetches are in flight at once.
   *
   * One at a time is fine at devnet volume and falls behind a busy mainnet:
   * a tick of 100 signatures costs 100 sequential round trips, so the feed's
   * throughput is capped at (page size / RTT) no matter how fast the chain
   * moves. The cursor semantics already tolerate concurrency — results are
   * applied in slot order and the cursor advances only over the prefix that
   * applied — which is what makes this safe rather than merely faster.
   */
  fetchConcurrency?: number;
  onError?: (err: unknown, where: string) => void;
  /** Every upstream RPC call, so the bill and the error rate are visible. */
  onRpcCall?: (ok: boolean) => void;
}

/** Run `f` over `items` with at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  f: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await f(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export class LaunchpadIndexer {
  constructor(private readonly o: IndexerOptions) {}

  /** One poll cycle. Returns how many transactions were applied. */
  async runTick(): Promise<{ processed: number }> {
    const cursor = this.o.store.getCursor();
    let sigs: SignatureRef[];
    try {
      sigs = await this.o.source.fetchSignatures(cursor.lastSignature, this.o.pageLimit ?? 100);
      this.o.onRpcCall?.(true);
    } catch (err) {
      this.o.onRpcCall?.(false);
      this.o.onError?.(err, "fetchSignatures");
      return { processed: 0 };
    }
    if (sigs.length === 0) return { processed: 0 };

    // Oldest-first, so the cursor only advances over fully applied history.
    const ordered = [...sigs].sort((a, b) => a.slot - b.slot);

    // Fetch concurrently, then apply STRICTLY in order. The concurrency is an
    // I/O detail; the ordering is a correctness property, so they are kept in
    // separate steps rather than interleaved.
    const fetched = await mapWithConcurrency(
      ordered,
      this.o.fetchConcurrency ?? 8,
      async (ref): Promise<{ ref: SignatureRef; tx?: FetchedTransaction | null; err?: unknown }> => {
        try {
          const tx = await this.o.source.fetchTransaction(ref.signature);
          this.o.onRpcCall?.(true);
          return { ref, tx };
        } catch (err) {
          this.o.onRpcCall?.(false);
          return { ref, err };
        }
      },
    );

    let processed = 0;
    let newest: SignatureRef | null = null;
    for (const r of fetched) {
      if (r.err !== undefined) {
        this.o.onError?.(r.err, `fetchTransaction ${r.ref.signature}`);
        // Stop at the gap. Anything already fetched beyond it is DISCARDED
        // rather than applied, because applying it would fold events in out
        // of order and move the cursor over history we never read. The next
        // tick refetches from here.
        break;
      }
      if (r.tx) {
        this.applyTransaction(r.tx);
        processed += 1;
      }
      newest = r.ref;
    }
    if (newest) this.o.store.setCursor({ lastSignature: newest.signature, lastSlot: newest.slot });
    return { processed };
  }

  /** Decode and fold one transaction's events. Public for direct testing. */
  applyTransaction(tx: FetchedTransaction): void {
    tx.eventDatas.forEach((data, ixIndex) => {
      const ev = decodeLaunchpadEvent(data);
      if (!ev) return; // unknown/foreign — tolerated (upgrade rule)
      this.apply(ev, tx, ixIndex);
      this.o.sink?.(ev, { signature: tx.signature, slot: tx.slot });
    });
  }

  private apply(ev: LaunchpadEvent, tx: FetchedTransaction, ixIndex: number): void {
    switch (ev.kind) {
      case "create":
        this.o.store.upsertCoin({
          mint: ev.mint.toBase58(),
          name: ev.name,
          symbol: ev.symbol,
          uri: ev.uri,
          creator: ev.creator.toBase58(),
          virtualSol: ev.virtualSol.toString(),
          virtualToken: ev.virtualToken.toString(),
          realSol: "0",
          realToken: ev.realToken.toString(),
          complete: 0,
          migrated: 0,
          poolState: null,
          createdSlot: tx.slot,
          createdBlockTime: tx.blockTime,
          lastSlot: tx.slot,
        });
        break;
      case "trade":
        this.o.store.insertTrade({
          signature: tx.signature,
          ixIndex,
          mint: ev.mint.toBase58(),
          trader: ev.user.toBase58(),
          isBuy: ev.isBuy ? 1 : 0,
          tokenAmount: ev.tokenAmount.toString(),
          solAmount: ev.solAmount.toString(),
          virtualSol: ev.virtualSol.toString(),
          virtualToken: ev.virtualToken.toString(),
          realSol: ev.realSol.toString(),
          realToken: ev.realToken.toString(),
          slot: tx.slot,
          blockTime: tx.blockTime,
        });
        this.o.store.updateCoinState(ev.mint.toBase58(), {
          virtualSol: ev.virtualSol,
          virtualToken: ev.virtualToken,
          realSol: ev.realSol,
          realToken: ev.realToken,
          slot: tx.slot,
        });
        break;
      case "complete":
        // Virtual reserves are untouched by completion (left undefined = kept);
        // only the realized raise, the emptied sellable reserve, and the flag.
        this.o.store.updateCoinState(ev.mint.toBase58(), {
          realSol: ev.raisedLamports,
          realToken: 0n,
          complete: true,
          slot: tx.slot,
        });
        break;
      case "migrate":
        this.o.store.updateCoinState(ev.mint.toBase58(), {
          realSol: 0n,
          realToken: 0n,
          migrated: true,
          poolState: ev.poolState.toBase58(),
          slot: tx.slot,
        });
        break;
    }
  }
}
