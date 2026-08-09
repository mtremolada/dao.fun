/**
 * The live feed's reconnect policy, and the resync that makes a drop harmless.
 *
 * Two failures this defends against, neither visible on a healthy day:
 *
 *  - **The thundering herd.** A server restart drops every client at the same
 *    instant. Reconnecting on a fixed timer means they all come back at the
 *    same instant too, and finish what the restart started. Jitter is the
 *    entire fix, and a test that only checks "it retries" would pass without
 *    it.
 *  - **The silent hole.** Events published while a client was disconnected are
 *    simply gone, and a gap in a trade tape looks exactly like a quiet market.
 *    Re-reading state on every connect is what makes that impossible.
 */
import { describe, expect, it, vi } from "vitest";

/** The API must look configured before the module reads the env at import. */
process.env.NEXT_PUBLIC_API_URL = "https://api.test";

const { subscribeLaunchpad } = await import("../lib/launchpad-api");

type Listener = (e: MessageEvent) => void;

/** A scriptable EventSource that records every instance created. */
function fakeEventSourceClass() {
  const instances: FakeES[] = [];
  class FakeES {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    listeners = new Map<string, Listener[]>();
    constructor(public url: string) {
      instances.push(this);
    }
    addEventListener(kind: string, fn: Listener) {
      const l = this.listeners.get(kind) ?? [];
      l.push(fn);
      this.listeners.set(kind, l);
    }
    close() {
      this.closed = true;
    }
    emit(kind: string, data: unknown) {
      for (const fn of this.listeners.get(kind) ?? []) {
        fn({ data: JSON.stringify(data) } as MessageEvent);
      }
    }
  }
  return { instances, Class: FakeES as unknown as typeof EventSource };
}

/** A clock that runs scheduled callbacks on demand and records the delays. */
function fakeClock() {
  const queue: { at: number; cb: () => void; id: number }[] = [];
  let id = 0;
  return {
    delays: [] as number[],
    setTimeoutImpl(cb: () => void, ms: number) {
      this.delays.push(ms);
      queue.push({ at: ms, cb, id: ++id });
      return id;
    },
    clearTimeoutImpl(h: number) {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    runAll() {
      while (queue.length) queue.shift()!.cb();
    },
  };
}

describe("subscribeLaunchpad", () => {
  it("resyncs on the FIRST connect, not only on reconnects", async () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    const resyncs: number[] = [];
    subscribeLaunchpad(() => {}, {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      onResync: () => resyncs.push(1),
    });
    expect(es.instances).toHaveLength(1);
    es.instances[0]!.onopen!();
    // State that existed before the stream opened has to come from somewhere.
    expect(resyncs).toHaveLength(1);
  });

  it("resyncs again after a reconnect, so the gap cannot stay invisible", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    let resyncs = 0;
    subscribeLaunchpad(() => {}, {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      random: () => 0.5,
      onResync: () => resyncs++,
    });
    es.instances[0]!.onopen!();
    expect(resyncs).toBe(1);

    es.instances[0]!.onerror!();
    clock.runAll();
    expect(es.instances).toHaveLength(2);
    es.instances[1]!.onopen!();
    expect(resyncs).toBe(2);
  });

  it("closes the dead source before reconnecting, so clients do not double up", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    subscribeLaunchpad(() => {}, {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      random: () => 0.5,
    });
    es.instances[0]!.onerror!();
    expect(es.instances[0]!.closed).toBe(true);
    clock.runAll();
    expect(es.instances).toHaveLength(2);
  });

  it("backs off exponentially and CAPS the wait", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    subscribeLaunchpad(() => {}, {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      random: () => 0.999_999, // ~the top of each jitter window
    });
    for (let i = 0; i < 10; i++) {
      es.instances.at(-1)!.onerror!();
      clock.runAll();
    }
    // 1s, 2s, 4s, 8s, 16s, then pinned at the 30s ceiling.
    expect(clock.delays.slice(0, 5)).toEqual([999, 1999, 3999, 7999, 15999]);
    expect(Math.max(...clock.delays)).toBeLessThan(30_000);
  });

  it("JITTERS, so a restarted server is not hit by the whole herd at once", () => {
    const draws = [0.01, 0.99, 0.5, 0.25];
    const delays = draws.map((d) => {
      const es = fakeEventSourceClass();
      const clock = fakeClock();
      subscribeLaunchpad(() => {}, {
        EventSourceImpl: es.Class,
        setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
        clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
        random: () => d,
      });
      es.instances[0]!.onerror!();
      return clock.delays[0]!;
    });
    // Four clients dropped by the same event come back at four different
    // times. Identical delays here would mean the jitter is decorative.
    expect(new Set(delays).size).toBe(4);
  });

  it("stops for good after unsubscribe — no reconnect, no late events", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    const seen: unknown[] = [];
    const stop = subscribeLaunchpad((_k, d) => seen.push(d), {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      random: () => 0.5,
    });
    const first = es.instances[0]!;
    stop();
    expect(first.closed).toBe(true);
    first.onerror!();
    clock.runAll();
    expect(es.instances).toHaveLength(1);
    first.emit("launchpad:trade", { x: 1 });
    expect(seen).toEqual([]);
  });

  it("reports its state, so a stalled feed is visible rather than quiet", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    const states: string[] = [];
    subscribeLaunchpad(() => {}, {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
      random: () => 0.5,
      onStatus: (s) => states.push(s),
    });
    es.instances[0]!.onopen!();
    es.instances[0]!.onerror!();
    expect(states).toEqual(["connecting", "open", "reconnecting"]);
  });

  it("delivers decoded events and survives a malformed frame", () => {
    const es = fakeEventSourceClass();
    const clock = fakeClock();
    const seen: unknown[] = [];
    subscribeLaunchpad((_k, d) => seen.push(d), {
      EventSourceImpl: es.Class,
      setTimeoutImpl: clock.setTimeoutImpl.bind(clock),
      clearTimeoutImpl: clock.clearTimeoutImpl.bind(clock),
    });
    const src = es.instances[0]!;
    src.emit("launchpad:trade", { mint: "abc" });
    for (const fn of src.listeners.get("launchpad:trade") ?? []) {
      expect(() => fn({ data: "not json" } as MessageEvent)).not.toThrow();
    }
    expect(seen).toEqual([{ mint: "abc" }]);
  });
});

vi.stubGlobal("EventSource", undefined);
