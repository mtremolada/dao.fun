/**
 * Metrics and the caps that keep the fan-out available.
 *
 * The two properties worth writing down:
 *
 *  - **indexer lag must be absent, not zero, when it is unknown.** A metric
 *    that reports 0 because it could not read the chain looks exactly like a
 *    perfectly healthy feed, and it will be believed. Absence is honest;
 *    false health is not.
 *  - **a per-client cap must exist alongside the global one.** With only a
 *    global cap, one client opening a thousand connections reaches it alone
 *    and every other viewer is refused — a denial of service that needs no
 *    exploit, just a loop.
 */
import { describe, expect, it } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Metrics, toPrometheus } from "../src/launchpad/metrics";
import { SseHub, clientKey } from "../src/launchpad/sse";

/** A fake request/response pair good enough for the hub's surface. */
function pair(ip: string) {
  const listeners: Record<string, (() => void)[]> = {};
  const req = {
    headers: { "x-forwarded-for": ip },
    socket: { remoteAddress: "10.0.0.1" },
    on(ev: string, cb: () => void) {
      (listeners[ev] ??= []).push(cb);
    },
  } as unknown as IncomingMessage;
  const res = {
    statusCode: 0,
    ended: false,
    writeHead(code: number) {
      (res as unknown as { statusCode: number }).statusCode = code;
      return res;
    },
    write() {
      return true;
    },
    end() {
      (res as unknown as { ended: boolean }).ended = true;
    },
    on() {},
  } as unknown as ServerResponse & { statusCode: number };
  return { req, res, fire: (ev: string) => listeners[ev]?.forEach((f) => f()) };
}

describe("SseHub caps", () => {
  it("refuses a client past its OWN cap while others still connect", () => {
    const rejected: string[] = [];
    const hub = new SseHub({
      maxPerClient: 3,
      onRejected: (reason) => rejected.push(reason),
    });

    for (let i = 0; i < 3; i++) {
      expect(hub.subscribe(...twoOf(pair("1.2.3.4")))).toBe(true);
    }
    const fourth = pair("1.2.3.4");
    expect(hub.subscribe(fourth.req, fourth.res)).toBe(false);
    expect(fourth.res.statusCode).toBe(429);
    expect(rejected).toEqual(["per-client"]);

    // The greedy client did not take the site down with it.
    const other = pair("5.6.7.8");
    expect(hub.subscribe(other.req, other.res)).toBe(true);
    expect(hub.size).toBe(4);
    hub.close();
  });

  it("frees a slot when a connection closes, and only once", () => {
    const hub = new SseHub({ maxPerClient: 1 });
    const first = pair("1.2.3.4");
    expect(hub.subscribe(first.req, first.res)).toBe(true);
    expect(hub.countFor("1.2.3.4")).toBe(1);

    // Both events can fire for one connection; a double decrement would let
    // the cap drift upward until it no longer caps anything.
    first.fire("close");
    first.fire("close");
    expect(hub.countFor("1.2.3.4")).toBe(0);

    const again = pair("1.2.3.4");
    expect(hub.subscribe(again.req, again.res)).toBe(true);
    expect(hub.countFor("1.2.3.4")).toBe(1);
    hub.close();
  });

  it("still enforces the global cap, which is the spoof-proof backstop", () => {
    const rejected: string[] = [];
    const hub = new SseHub({ maxClients: 2, maxPerClient: 99, onRejected: (r) => rejected.push(r) });
    expect(hub.subscribe(...twoOf(pair("a")))).toBe(true);
    expect(hub.subscribe(...twoOf(pair("b")))).toBe(true);
    const third = pair("c");
    expect(hub.subscribe(third.req, third.res)).toBe(false);
    expect(third.res.statusCode).toBe(503);
    expect(rejected).toEqual(["global"]);
    hub.close();
  });

  it("attributes a proxied client to its forwarded address, not the proxy's", () => {
    const { req } = pair("203.0.113.9");
    expect(clientKey(req)).toBe("203.0.113.9");
  });
});

function twoOf(p: ReturnType<typeof pair>): [IncomingMessage, ServerResponse] {
  return [p.req, p.res];
}

describe("Metrics", () => {
  it("reports indexer lag as chain head minus what we folded in", async () => {
    const m = new Metrics({ indexedSlot: () => 1_000, chainSlot: async () => 1_042 });
    const s = await m.snapshot();
    expect(s.indexerLagSlots).toBe(42);
  });

  it("reports lag as UNKNOWN rather than zero when the chain head cannot be read", async () => {
    const m = new Metrics({ indexedSlot: () => 1_000, chainSlot: async () => null });
    expect((await m.snapshot()).indexerLagSlots).toBeNull();
  });

  it("survives a gauge that throws — observability must not fail when things do", async () => {
    const m = new Metrics({
      indexedSlot: () => 5,
      chainSlot: async () => {
        throw new Error("rpc down");
      },
      keeperLamports: async () => {
        throw new Error("rpc down");
      },
    });
    const s = await m.snapshot();
    expect(s.chainSlot).toBeNull();
    expect(s.keeperLamports).toBeNull();
    expect(s.indexedSlot).toBe(5);
  });

  it("never reports negative lag when the indexed slot runs ahead of a stale read", async () => {
    const m = new Metrics({ indexedSlot: () => 2_000, chainSlot: async () => 1_999 });
    expect((await m.snapshot()).indexerLagSlots).toBe(0);
  });

  it("counts events and computes a rate over the window", async () => {
    let now = 1_000_000;
    const m = new Metrics({}, () => now, 60_000);
    for (let i = 0; i < 120; i++) m.eventPublished();
    let s = await m.snapshot();
    expect(s.eventsPublishedTotal).toBe(120);
    expect(s.eventsPerSecond).toBe(2); // 120 in the last minute

    // The cumulative total keeps climbing; the rate falls back to zero once
    // the window has rolled past them. A total alone cannot say "right now".
    now += 120_000;
    s = await m.snapshot();
    expect(s.eventsPublishedTotal).toBe(120);
    expect(s.eventsPerSecond).toBe(0);
  });

  it("separates the calls we PAY for from the ones we merely proxy", async () => {
    const m = new Metrics();
    m.rpcProxyCall(true);
    m.rpcProxyCall(false);
    m.upstreamCall(true);
    const s = await m.snapshot();
    expect(s.rpcProxyCallsTotal).toBe(2);
    expect(s.rpcProxyErrorsTotal).toBe(1);
    expect(s.upstreamCallsTotal).toBe(1);
    expect(s.upstreamErrorsTotal).toBe(0);
  });

  it("omits unknown values from the Prometheus text instead of exporting zeros", async () => {
    const m = new Metrics({ indexedSlot: () => 10, chainSlot: async () => null });
    const text = toPrometheus(await m.snapshot());
    expect(text).toContain("daofun_indexed_slot 10");
    // A scraped `lag 0` would silence exactly the alert this metric exists for.
    expect(text).not.toContain("daofun_indexer_lag_slots");
  });
});
