/**
 * Launchpad backend — store, indexer, HTTP routes, RPC proxy, airdrop, CORS.
 * Real node:http servers around the injected handler + fake seams, the same
 * contract-pinning pattern as http-api.test.ts. The indexer is driven with a
 * fake TxSource replaying event bytes encoded exactly as the on-chain
 * emit_cpi does, so decode + fold is proven without a chain.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { EVENT_IX_TAG, eventDiscriminator } from "@daofun/sdk/launchpad";
import { SqliteLaunchpadStore } from "../src/launchpad/store";
import {
  LaunchpadIndexer,
  type FetchedTransaction,
  type SignatureRef,
  type TxSource,
} from "../src/launchpad/indexer";
import {
  createLaunchpadHandler,
  type LaunchpadHandlerDeps,
} from "../src/launchpad/handler";
import { withCors } from "../src/cors";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
});

async function start(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

// ---- event byte encoders, mirroring the on-chain borsh layout ----
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const str = (s: string) => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const evt = (name: string, body: Buffer) =>
  Buffer.concat([EVENT_IX_TAG, eventDiscriminator(name), body]);

const MINT = Keypair.generate().publicKey;
const USER = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;

const createEvt = () =>
  evt(
    "CreateEvent",
    Buffer.concat([
      MINT.toBuffer(),
      CREATOR.toBuffer(),
      str("Test Coin"),
      str("TEST"),
      str("https://arweave.net/x"),
      u64(30_000_000_000n),
      u64(1_073_000_000_000_000n),
      u64(793_100_000_000_000n),
      u64(1_000_000_000_000_000n),
    ]),
  );
const tradeEvt = (realSol: bigint, realToken: bigint) =>
  evt(
    "TradeEvent",
    Buffer.concat([
      MINT.toBuffer(),
      USER.toBuffer(),
      Buffer.from([1]),
      u64(1_000_000n),
      u64(realSol),
      u64(0n),
      u64(0n),
      u64(30_000_000_000n + realSol),
      u64(1_073_000_000_000_000n - 1_000_000n),
      u64(realSol),
      u64(realToken),
    ]),
  );

function memStore() {
  return new SqliteLaunchpadStore(":memory:");
}

describe("store", () => {
  it("upserts a coin and lists it on the board, then rolls state forward", () => {
    const s = memStore();
    s.upsertCoin({
      mint: MINT.toBase58(), name: "T", symbol: "T", uri: "u", creator: CREATOR.toBase58(),
      virtualSol: "30000000000", virtualToken: "1073000000000000", realSol: "0",
      realToken: "793100000000000", complete: 0, migrated: 0, poolState: null,
      createdSlot: 10, createdBlockTime: 100, lastSlot: 10,
    });
    expect(s.listCoins({ filter: "new" })).toHaveLength(1);
    s.updateCoinState(MINT.toBase58(), { realSol: 5000n, slot: 11 });
    expect(s.getCoin(MINT.toBase58())?.realSol).toBe("5000");
    // A stale (older slot) update is ignored.
    s.updateCoinState(MINT.toBase58(), { realSol: 1n, slot: 5 });
    expect(s.getCoin(MINT.toBase58())?.realSol).toBe("5000");
  });

  it("splits the three board columns by PROGRESS, not just by flags", () => {
    const s = memStore();
    const coin = (mint: string, realToken: string, complete = 0, migrated = 0) =>
      s.upsertCoin({
        mint, name: mint, symbol: mint, uri: "u", creator: CREATOR.toBase58(),
        virtualSol: "30000000000", virtualToken: "1073000000000000", realSol: "0",
        realToken, complete, migrated, poolState: null,
        createdSlot: 10, createdBlockTime: 100, lastSlot: 10,
      });
    // fresh: nothing sold. nearly: 90% of the 793.1e12 reserve sold.
    // done: complete but not yet cranked. gone: migrated.
    coin("fresh", "793100000000000");
    coin("nearly", "79310000000000");
    coin("done", "0", 1);
    coin("gone", "0", 1, 1);

    const names = (f: "new" | "graduating" | "graduated") =>
      s.listCoins({ filter: f }).map((c) => c.mint).sort();

    // "About to graduate" must NOT be a synonym for "new": it is the
    // high-progress tail plus anything complete but awaiting the crank.
    expect(names("graduating")).toEqual(["done", "nearly"]);
    expect(names("new")).toEqual(["fresh"]);
    expect(names("graduated")).toEqual(["gone"]);
  });

  it("respects a custom progress threshold for the graduating column", () => {
    const s = memStore();
    s.upsertCoin({
      mint: "half", name: "H", symbol: "H", uri: "u", creator: CREATOR.toBase58(),
      virtualSol: "30000000000", virtualToken: "1073000000000000", realSol: "0",
      realToken: "396550000000000", complete: 0, migrated: 0, poolState: null,
      createdSlot: 10, createdBlockTime: 100, lastSlot: 10,
    });
    // 50% sold: below the 80% default, at/above a 50% threshold.
    expect(s.listCoins({ filter: "graduating" })).toHaveLength(0);
    expect(s.listCoins({ filter: "graduating", progressThresholdBps: 5000 })).toHaveLength(1);
    expect(s.listCoins({ filter: "new", progressThresholdBps: 5000 })).toHaveLength(0);
  });

  it("keeps virtual reserves when a completion event only carries the raise", () => {
    const s = memStore();
    s.upsertCoin({
      mint: MINT.toBase58(), name: "T", symbol: "T", uri: "u", creator: CREATOR.toBase58(),
      virtualSol: "115000000000", virtualToken: "1000000000000000", realSol: "0",
      realToken: "793100000000000", complete: 0, migrated: 0, poolState: null,
      createdSlot: 1, createdBlockTime: 1, lastSlot: 1,
    });
    s.updateCoinState(MINT.toBase58(), { realSol: 85_005_359_057n, realToken: 0n, complete: true, slot: 2 });
    const c = s.getCoin(MINT.toBase58())!;
    expect(c.complete).toBe(1);
    expect(c.virtualSol).toBe("115000000000"); // untouched
    expect(c.realToken).toBe("0");
  });
});

describe("indexer", () => {
  function fakeSource(txs: FetchedTransaction[]): TxSource {
    return {
      async fetchSignatures(after: string | null): Promise<SignatureRef[]> {
        const idx = after ? txs.findIndex((t) => t.signature === after) : -1;
        return txs.slice(idx + 1).map((t) => ({ signature: t.signature, slot: t.slot })).reverse();
      },
      async fetchTransaction(sig: string) {
        return txs.find((t) => t.signature === sig) ?? null;
      },
    };
  }

  it("folds create + trade + complete + migrate into the store", async () => {
    const store = memStore();
    const txs: FetchedTransaction[] = [
      { signature: "sig1", slot: 1, blockTime: 100, eventDatas: [createEvt()] },
      { signature: "sig2", slot: 2, blockTime: 110, eventDatas: [tradeEvt(5_000_000n, 792_000_000_000_000n)] },
      { signature: "sig3", slot: 3, blockTime: 120, eventDatas: [evt("CompleteEvent", Buffer.concat([MINT.toBuffer(), u64(85_005_359_057n), u64(206_900_000_000_000n)]))] },
      { signature: "sig4", slot: 4, blockTime: 130, eventDatas: [evt("MigrateEvent", Buffer.concat([MINT.toBuffer(), CREATOR.toBuffer(), u64(84_000_000_000n), u64(206_900_000_000_000n), u64(1n), u64(150_000_000n), u64(0n)]))] },
    ];
    const seen: string[] = [];
    const ix = new LaunchpadIndexer({ store, source: fakeSource(txs), sink: (e) => seen.push(e.kind) });
    const r = await ix.runTick();
    expect(r.processed).toBe(4);
    expect(seen).toEqual(["create", "trade", "complete", "migrate"]);
    const c = store.getCoin(MINT.toBase58())!;
    expect(c.complete).toBe(1);
    expect(c.migrated).toBe(1);
    expect(c.poolState).toBe(CREATOR.toBase58());
    expect(store.listTrades(MINT.toBase58())).toHaveLength(1);
  });

  it("is idempotent across a re-scan (cursor reset)", async () => {
    const store = memStore();
    const txs: FetchedTransaction[] = [
      { signature: "sig1", slot: 1, blockTime: 100, eventDatas: [createEvt()] },
      { signature: "sig2", slot: 2, blockTime: 110, eventDatas: [tradeEvt(5_000_000n, 792_000_000_000_000n)] },
    ];
    const ix = new LaunchpadIndexer({ store, source: fakeSource(txs) });
    await ix.runTick();
    store.setCursor({ lastSignature: null, lastSlot: 0 }); // simulate a rollback re-scan
    await ix.runTick();
    expect(store.listTrades(MINT.toBase58())).toHaveLength(1); // not doubled
  });

  it("ignores unknown event discriminators (upgrade tolerance)", async () => {
    const store = memStore();
    const unknown = Buffer.concat([EVENT_IX_TAG, eventDiscriminator("FutureEvent"), MINT.toBuffer()]);
    const ix = new LaunchpadIndexer({
      store,
      source: fakeSource([{ signature: "s", slot: 1, blockTime: 1, eventDatas: [unknown] }]),
    });
    const r = await ix.runTick();
    expect(r.processed).toBe(1);
    expect(store.getCoin(MINT.toBase58())).toBeUndefined();
  });
});

describe("http routes", () => {
  function seeded(): SqliteLaunchpadStore {
    const s = memStore();
    s.upsertCoin({
      mint: MINT.toBase58(), name: "Test", symbol: "TST", uri: "https://x", creator: CREATOR.toBase58(),
      virtualSol: "30000000000", virtualToken: "1073000000000000", realSol: "5000000",
      realToken: "790000000000000", complete: 0, migrated: 0, poolState: null,
      createdSlot: 1, createdBlockTime: 1000, lastSlot: 1,
    });
    s.insertTrade({
      signature: "sigA", ixIndex: 0, mint: MINT.toBase58(), trader: USER.toBase58(), isBuy: 1,
      tokenAmount: "1000000", solAmount: "5000000", virtualSol: "30005000000",
      virtualToken: "1072999000000000", realSol: "5000000", realToken: "790000000000000",
      slot: 1, blockTime: 1000,
    });
    return s;
  }

  async function handler(over: Partial<LaunchpadHandlerDeps> = {}) {
    return start(createLaunchpadHandler({ store: seeded(), ...over }));
  }

  it("serves /health, /board, /coins/:mint, /trades, /candles", async () => {
    const base = await handler();
    expect((await (await fetch(`${base}/health`)).json()).ok).toBe(true);
    const board = await (await fetch(`${base}/launchpad/board`)).json();
    expect(board.coins[0].symbol).toBe("TST");
    expect(board.coins[0].progressBps).toBeGreaterThan(0);
    const coin = await (await fetch(`${base}/launchpad/coins/${MINT.toBase58()}`)).json();
    expect(coin.coin.mint).toBe(MINT.toBase58());
    const trades = await (await fetch(`${base}/launchpad/coins/${MINT.toBase58()}/trades`)).json();
    expect(trades.trades).toHaveLength(1);
    const candles = await (await fetch(`${base}/launchpad/coins/${MINT.toBase58()}/candles?res=60`)).json();
    expect(candles.candles.length).toBeGreaterThanOrEqual(1);
  });

  it("404s an unknown coin and 400s a bad mint", async () => {
    const base = await handler();
    expect((await fetch(`${base}/launchpad/coins/${Keypair.generate().publicKey.toBase58()}`)).status).toBe(404);
    expect((await fetch(`${base}/launchpad/coins/not-a-key`)).status).toBe(400);
  });

  it("501s optional capabilities that are not wired", async () => {
    const base = await handler();
    expect((await fetch(`${base}/launchpad/events`)).status).toBe(501);
    expect((await fetch(`${base}/rpc/devnet`, { method: "POST", body: "{}" })).status).toBe(501);
    expect((await fetch(`${base}/launchpad/airdrop`, { method: "POST", body: "{}" })).status).toBe(501);
  });
});

describe("rpc proxy", () => {
  it("forwards allowlisted methods and blocks the rest; never exposes the key", async () => {
    let upstreamCalls = 0;
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok", echo: JSON.parse(String(init?.body)) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const base = await start(
      createLaunchpadHandler({
        store: memStore(),
        rpcProxy: { upstreamUrl: "https://devnet.helius-rpc.com/?api-key=SECRET", fetchImpl: fakeFetch, burst: 5, ratePerSecond: 5 },
      }),
    );
    const ok = await fetch(`${base}/rpc/devnet`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] }),
    });
    expect(ok.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    const blocked = await fetch(`${base}/rpc/devnet`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [] }),
    });
    expect(blocked.status).toBe(403);
    expect(upstreamCalls).toBe(1); // not forwarded
  });

  it("rate limits per IP", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const base = await start(
      createLaunchpadHandler({
        store: memStore(),
        rpcProxy: { upstreamUrl: "https://x", fetchImpl: fakeFetch, burst: 2, ratePerSecond: 0 },
      }),
    );
    const call = () =>
      fetch(`${base}/rpc/devnet`, {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [] }),
      });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429); // burst of 2 exhausted, no refill
  });
});

describe("airdrop", () => {
  it("dispenses once then cools down, with a faucet fallback", async () => {
    let calls = 0;
    const base = await start(
      createLaunchpadHandler({
        store: memStore(),
        airdrop: {
          requestAirdrop: async () => {
            calls += 1;
            return "airdropSig";
          },
          cooldownMs: 3600_000,
          faucetUrl: "https://faucet.solana.com",
        },
      }),
    );
    const pk = Keypair.generate().publicKey.toBase58();
    const first = await fetch(`${base}/launchpad/airdrop`, { method: "POST", body: JSON.stringify({ pubkey: pk }) });
    expect(first.status).toBe(200);
    expect((await first.json()).signature).toBe("airdropSig");
    const second = await fetch(`${base}/launchpad/airdrop`, { method: "POST", body: JSON.stringify({ pubkey: pk }) });
    expect(second.status).toBe(429);
    expect((await second.json()).fallback).toContain("faucet.solana.com");
    expect(calls).toBe(1);
  });
});

describe("metadata upload", () => {
  it("rejects a bad MIME and accepts an allowed image via the injected uploader", async () => {
    const base = await start(
      createLaunchpadHandler({
        store: memStore(),
        metadata: {
          uploader: {
            upload: async (i) => ({ uri: `https://arweave.net/json`, imageUri: `https://arweave.net/${i.imageMime}` }),
          },
        },
      }),
    );
    const bad = await fetch(`${base}/launchpad/metadata`, {
      method: "POST",
      body: JSON.stringify({ name: "n", symbol: "s", imageBase64: "AAAA", imageMime: "image/svg+xml" }),
    });
    expect(bad.status).toBe(415);
    const ok = await fetch(`${base}/launchpad/metadata`, {
      method: "POST",
      body: JSON.stringify({ name: "n", symbol: "s", imageBase64: Buffer.from("hi").toString("base64"), imageMime: "image/png" }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).uri).toContain("arweave.net");
  });
});

describe("cors", () => {
  it("allows the configured origin and answers preflight", async () => {
    const base = await start(
      withCors(createLaunchpadHandler({ store: memStore() }), { origins: ["https://app.example"] }),
    );
    const pre = await fetch(`${base}/launchpad/board`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const denied = await fetch(`${base}/launchpad/board`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.status).toBe(403);
  });
});
