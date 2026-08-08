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
  onError?: (err: unknown, where: string) => void;
}

export class LaunchpadIndexer {
  constructor(private readonly o: IndexerOptions) {}

  /** One poll cycle. Returns how many transactions were applied. */
  async runTick(): Promise<{ processed: number }> {
    const cursor = this.o.store.getCursor();
    let sigs: SignatureRef[];
    try {
      sigs = await this.o.source.fetchSignatures(cursor.lastSignature, this.o.pageLimit ?? 100);
    } catch (err) {
      this.o.onError?.(err, "fetchSignatures");
      return { processed: 0 };
    }
    if (sigs.length === 0) return { processed: 0 };

    // Oldest-first, so the cursor only advances over fully applied history.
    const ordered = [...sigs].sort((a, b) => a.slot - b.slot);
    let processed = 0;
    let newest: SignatureRef | null = null;
    for (const ref of ordered) {
      let tx: FetchedTransaction | null;
      try {
        tx = await this.o.source.fetchTransaction(ref.signature);
      } catch (err) {
        this.o.onError?.(err, `fetchTransaction ${ref.signature}`);
        // Stop advancing past a gap we couldn't read; next tick retries it.
        break;
      }
      if (tx) {
        this.applyTransaction(tx);
        processed += 1;
      }
      newest = ref;
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
