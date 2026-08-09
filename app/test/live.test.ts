/**
 * The live feed's contract, especially when it cannot be live.
 *
 * The failure mode that matters is not "the socket broke" — it is a screen
 * that LOOKS live and is not. Every RPC is entitled to refuse
 * `programSubscribe`; when that happens the app must fall back to polling and
 * SAY it is polling, so the honest state is visible rather than a frozen tape
 * that reads as a quiet market.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import { watchAllCurves, watchCurve, type LiveStatus } from "../lib/live";
import { CURVE_ACCOUNT_LEN } from "../lib/chain-coin";

const MINT = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function curveBytes(realSol: bigint): Buffer {
  const b = Buffer.concat([
    Buffer.alloc(8),
    MINT.toBuffer(),
    PublicKey.default.toBuffer(),
    u64(30_000_000_000n),
    u64(1_073_000_000_000_000n),
    u64(realSol),
    u64(793_100_000_000_000n),
    Buffer.from([70, 0, 30, 0]),
    Buffer.from([0, 0]),
    PublicKey.default.toBuffer(),
    Buffer.from([255]),
  ]);
  expect(b.length).toBe(CURVE_ACCOUNT_LEN);
  return b;
}

afterEach(() => vi.useRealTimers());

describe("watchAllCurves", () => {
  it("subscribes with the dataSize filter and pushes decoded curves", () => {
    const seen: bigint[] = [];
    let handler: ((info: { accountInfo: { data: Buffer } }) => void) | null = null;
    let filters: unknown;
    const connection = {
      onProgramAccountChange: (
        _p: PublicKey,
        cb: (info: { accountInfo: { data: Buffer } }) => void,
        _c: string,
        f: unknown,
      ) => {
        handler = cb;
        filters = f;
        return 7;
      },
      removeProgramAccountChangeListener: async () => {},
    } as unknown as Connection;

    const statuses: LiveStatus[] = [];
    const h = watchAllCurves(connection, (c) => seen.push(c.realSol), {
      onStatus: (s) => statuses.push(s),
    });

    // Without the size filter the Config account arrives here and decodes as
    // a coin — the same trap the scan guards against.
    expect(filters).toEqual([{ dataSize: CURVE_ACCOUNT_LEN }]);
    expect(statuses).toEqual(["connecting", "live"]);

    handler!({ accountInfo: { data: curveBytes(1_234n) } });
    expect(seen).toEqual([1_234n]);
    h.stop();
  });

  it("falls back to POLLING when the RPC refuses the subscription, and says so", async () => {
    vi.useFakeTimers();
    const connection = {
      onProgramAccountChange: () => {
        throw new Error("programSubscribe is not supported on this endpoint");
      },
      removeProgramAccountChangeListener: async () => {},
      getProgramAccounts: async () => [
        { pubkey: MINT, account: { data: curveBytes(99n) } },
      ],
    } as unknown as Connection;

    const statuses: LiveStatus[] = [];
    const seen: bigint[] = [];
    const h = watchAllCurves(connection, (c) => seen.push(c.realSol), {
      onStatus: (s) => statuses.push(s),
      fallbackPollMs: 1_000,
    });

    expect(statuses).toEqual(["connecting", "polling"]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(seen).toEqual([99n]);
    h.stop();
  });

  it("reconciles on a slow timer even while the socket looks healthy", async () => {
    // The failure this defends against is a socket that stops delivering
    // without erroring: the badge still says live, and the screen quietly
    // freezes. The reconcile read is why that cannot happen.
    vi.useFakeTimers();
    let reconciles = 0;
    const connection = {
      onProgramAccountChange: () => 1,
      removeProgramAccountChangeListener: async () => {},
      getProgramAccounts: async () => {
        reconciles++;
        return [{ pubkey: MINT, account: { data: curveBytes(7n) } }];
      },
    } as unknown as Connection;

    const seen: bigint[] = [];
    const h = watchAllCurves(connection, (c) => seen.push(c.realSol));
    expect(reconciles).toBe(0);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(reconciles).toBe(1);
    expect(seen).toEqual([7n]);
    h.stop();
    // ...and it stops with the handle, so an unmounted screen goes quiet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconciles).toBe(1);
  });

  it("does not scan the program while the tab is hidden, and catches up on return", async () => {
    // The reconcile read is a FULL program scan. Left running in every
    // background tab it is one of the largest avoidable costs in the client,
    // and a hidden tab has nothing to show for it.
    vi.useFakeTimers();
    const listeners: Record<string, (() => void)[]> = {};
    const doc = {
      visibilityState: "hidden" as string,
      addEventListener: (ev: string, cb: () => void) => {
        (listeners[ev] ??= []).push(cb);
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal("document", doc);
    let reconciles = 0;
    const connection = {
      onProgramAccountChange: () => 1,
      removeProgramAccountChangeListener: async () => {},
      getProgramAccounts: async () => {
        reconciles++;
        return [{ pubkey: MINT, account: { data: curveBytes(3n) } }];
      },
    } as unknown as Connection;

    const h = watchAllCurves(connection, () => {});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(reconciles).toBe(0); // four intervals elapsed, no scans

    doc.visibilityState = "visible";
    listeners.visibilitychange!.forEach((cb) => cb());
    await vi.advanceTimersByTimeAsync(1);
    // Back in front: reconcile immediately rather than showing a stale board
    // for the remainder of the interval.
    expect(reconciles).toBe(1);
    h.stop();
    vi.unstubAllGlobals();
  });

  it("reports the SOCKET's state, not the fact that subscribe() returned", () => {
    const listeners: Record<string, () => void> = {};
    const connection = {
      onProgramAccountChange: () => 1,
      removeProgramAccountChangeListener: async () => {},
      _rpcWebSocket: {
        on: (event: string, handler: () => void) => {
          listeners[event] = handler;
        },
      },
    } as unknown as Connection;

    const statuses: LiveStatus[] = [];
    const h = watchAllCurves(connection, () => {}, {
      onStatus: (s) => statuses.push(s),
    });
    // Subscribing is not connecting: nothing claims "live" yet.
    expect(statuses).toEqual(["connecting"]);
    listeners.open!();
    expect(statuses).toEqual(["connecting", "live"]);
    // And a dropped socket is visible rather than a frozen screen.
    listeners.close!();
    expect(statuses).toEqual(["connecting", "live", "polling"]);
    h.stop();
  });

  it("stops pushing after stop(), so an unmounted screen cannot update state", () => {
    let handler: ((info: { accountInfo: { data: Buffer } }) => void) | null = null;
    const connection = {
      onProgramAccountChange: (
        _p: PublicKey,
        cb: (info: { accountInfo: { data: Buffer } }) => void,
      ) => {
        handler = cb;
        return 1;
      },
      removeProgramAccountChangeListener: async () => {},
    } as unknown as Connection;

    const seen: bigint[] = [];
    const h = watchAllCurves(connection, (c) => seen.push(c.realSol));
    h.stop();
    handler!({ accountInfo: { data: curveBytes(5n) } });
    expect(seen).toEqual([]);
  });

  it("survives an account it cannot decode instead of taking the page down", () => {
    let handler: ((info: { accountInfo: { data: Buffer } }) => void) | null = null;
    const connection = {
      onProgramAccountChange: (
        _p: PublicKey,
        cb: (info: { accountInfo: { data: Buffer } }) => void,
      ) => {
        handler = cb;
        return 1;
      },
      removeProgramAccountChangeListener: async () => {},
    } as unknown as Connection;

    const seen: bigint[] = [];
    watchAllCurves(connection, (c) => seen.push(c.realSol));
    expect(() => handler!({ accountInfo: { data: Buffer.alloc(4) } })).not.toThrow();
    expect(seen).toEqual([]);
  });
});

describe("watchCurve", () => {
  it("watches one coin's account and pushes it decoded", () => {
    let handler: ((info: { data: Buffer }) => void) | null = null;
    const connection = {
      onAccountChange: (_a: PublicKey, cb: (info: { data: Buffer }) => void) => {
        handler = cb;
        return 3;
      },
      removeAccountChangeListener: async () => {},
    } as unknown as Connection;

    const seen: bigint[] = [];
    const h = watchCurve(connection, MINT.toBase58(), (c) => seen.push(c.realSol));
    handler!({ data: curveBytes(42n) });
    expect(seen).toEqual([42n]);
    h.stop();
  });

  it("is inert for a malformed mint rather than throwing at render time", () => {
    const connection = {} as unknown as Connection;
    expect(() => watchCurve(connection, "not-a-mint", () => {}).stop()).not.toThrow();
  });
});
