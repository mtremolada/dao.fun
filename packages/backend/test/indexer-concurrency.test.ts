/**
 * The indexer fetches transactions concurrently, and that must not cost the
 * property the cursor depends on.
 *
 * Serial fetching caps the feed at (page size × round trip) no matter how fast
 * the chain moves — fine on devnet, behind on a busy mainnet. Concurrency is
 * safe here ONLY because application order and fetch order are separate: the
 * results are applied strictly in slot order and the cursor advances over the
 * applied prefix alone.
 *
 * The dangerous version of this change is the one that also applies
 * concurrently, or that advances the cursor past a transaction it failed to
 * read. Both would look fine on a green chain and lose events on a flaky one,
 * so both are asserted below.
 */
import { describe, expect, it } from "vitest";
import { SqliteLaunchpadStore } from "../src/launchpad/store";
import {
  LaunchpadIndexer,
  type FetchedTransaction,
  type SignatureRef,
  type TxSource,
} from "../src/launchpad/indexer";

function txAt(slot: number): FetchedTransaction {
  return { signature: `sig${slot}`, slot, blockTime: slot, eventDatas: [] };
}

/**
 * A source that reports how many fetches overlapped, and can be told to fail
 * one specific signature.
 */
function source(slots: number[], opts: { failAt?: string; delayMs?: number } = {}) {
  const state = { inFlight: 0, peak: 0, fetched: [] as string[] };
  const src: TxSource = {
    async fetchSignatures(): Promise<SignatureRef[]> {
      // Newest-first, like getSignaturesForAddress — the indexer must sort.
      return [...slots].reverse().map((slot) => ({ signature: `sig${slot}`, slot }));
    },
    async fetchTransaction(signature: string): Promise<FetchedTransaction | null> {
      state.inFlight++;
      state.peak = Math.max(state.peak, state.inFlight);
      try {
        await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));
        if (signature === opts.failAt) throw new Error("rpc hiccup");
        state.fetched.push(signature);
        return txAt(Number(signature.replace("sig", "")));
      } finally {
        state.inFlight--;
      }
    },
  };
  return { src, state };
}

describe("indexer fetch concurrency", () => {
  it("overlaps fetches instead of paying one round trip at a time", async () => {
    const { src, state } = source([1, 2, 3, 4, 5, 6, 7, 8]);
    const ix = new LaunchpadIndexer({
      store: new SqliteLaunchpadStore(":memory:"),
      source: src,
      fetchConcurrency: 4,
    });
    await ix.runTick();
    expect(state.peak).toBeGreaterThan(1);
    expect(state.peak).toBeLessThanOrEqual(4);
  });

  it("honours the concurrency limit rather than fetching a whole page at once", async () => {
    const { src, state } = source(Array.from({ length: 50 }, (_, i) => i + 1));
    const ix = new LaunchpadIndexer({
      store: new SqliteLaunchpadStore(":memory:"),
      source: src,
      fetchConcurrency: 3,
    });
    await ix.runTick();
    expect(state.peak).toBe(3);
  });

  it("advances the cursor only to the last transaction it actually applied", async () => {
    // sig3 fails. Everything after it may already have been fetched — it must
    // NOT be applied, and the cursor must stop at sig2, or the next tick
    // resumes past history nobody ever read.
    const store = new SqliteLaunchpadStore(":memory:");
    const { src } = source([1, 2, 3, 4, 5], { failAt: "sig3" });
    const errors: string[] = [];
    const ix = new LaunchpadIndexer({
      store,
      source: src,
      fetchConcurrency: 5,
      onError: (_e, where) => errors.push(where),
    });
    const r = await ix.runTick();
    expect(r.processed).toBe(2);
    expect(errors).toEqual(["fetchTransaction sig3"]);
    expect(store.getCursor()).toMatchObject({ lastSignature: "sig2", lastSlot: 2 });
  });

  it("applies in slot order even though the fetches finish out of order", async () => {
    const applied: number[] = [];
    const store = new SqliteLaunchpadStore(":memory:");
    const slots = [10, 20, 30, 40];
    const src: TxSource = {
      async fetchSignatures() {
        return [...slots].reverse().map((slot) => ({ signature: `sig${slot}`, slot }));
      },
      async fetchTransaction(signature: string) {
        const slot = Number(signature.replace("sig", ""));
        // Deliberately inverted latency: the newest resolves first.
        await new Promise((r) => setTimeout(r, 40 - slot / 2));
        return txAt(slot);
      },
    };
    const ix = new LaunchpadIndexer({ store, source: src, fetchConcurrency: 4 });
    const original = ix.applyTransaction.bind(ix);
    ix.applyTransaction = (tx: FetchedTransaction) => {
      applied.push(tx.slot);
      original(tx);
    };
    await ix.runTick();
    expect(applied).toEqual([10, 20, 30, 40]);
  });

  it("counts every upstream call, successes and failures alike", async () => {
    const { src } = source([1, 2, 3], { failAt: "sig2" });
    const calls: boolean[] = [];
    const ix = new LaunchpadIndexer({
      store: new SqliteLaunchpadStore(":memory:"),
      source: src,
      fetchConcurrency: 3,
      onRpcCall: (ok) => calls.push(ok),
    });
    await ix.runTick();
    // 1 signature page + 3 transaction fetches, one of which failed.
    expect(calls).toHaveLength(4);
    expect(calls.filter((c) => !c)).toHaveLength(1);
  });
});
