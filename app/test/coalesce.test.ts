/**
 * One commit per frame.
 *
 * This is a cost property, and cost properties rot silently: the board looks
 * identical whether it re-rendered once or fifty times in a frame. So these
 * assert the number of FLUSHES, not the rendered result.
 */
import { describe, expect, it } from "vitest";
import { batchByFrame } from "../lib/coalesce";

/** A hand-cranked frame clock — nothing runs until a frame is asked for. */
function frames() {
  let pending: (() => void) | null = null;
  let handle = 0;
  return {
    schedule(cb: () => void) {
      pending = cb;
      return ++handle;
    },
    cancel() {
      pending = null;
    },
    tick() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    get scheduled() {
      return pending !== null;
    },
  };
}

describe("batchByFrame", () => {
  it("turns fifty events in one frame into ONE flush", () => {
    const f = frames();
    const flushes: number[][] = [];
    const b = batchByFrame<number>((items) => flushes.push(items), {
      schedule: f.schedule,
      cancel: f.cancel,
    });
    for (let i = 0; i < 50; i++) b.push(i);
    expect(flushes).toHaveLength(0); // nothing yet — that is the point
    f.tick();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toHaveLength(50);
  });

  it("still lands on the very NEXT frame — this is not a debounce", () => {
    const f = frames();
    const flushes: number[][] = [];
    const b = batchByFrame<number>((i) => flushes.push(i), { schedule: f.schedule, cancel: f.cancel });
    b.push(1);
    f.tick();
    // A debounce would have pushed this out to a later frame; latency is the
    // thing a live feed exists to provide, so it must be unchanged.
    expect(flushes).toEqual([[1]]);
  });

  it("collapses repeats per key, keeping the newest state for each", () => {
    const f = frames();
    const flushes: { mint: string; sol: number }[][] = [];
    const b = batchByFrame<{ mint: string; sol: number }>((i) => flushes.push(i), {
      key: (c) => c.mint,
      schedule: f.schedule,
      cancel: f.cancel,
    });
    b.push({ mint: "A", sol: 1 });
    b.push({ mint: "B", sol: 1 });
    b.push({ mint: "A", sol: 2 });
    b.push({ mint: "A", sol: 3 });
    f.tick();
    expect(flushes[0]).toEqual([{ mint: "B", sol: 1 }, { mint: "A", sol: 3 }]);
  });

  it("applies a re-pushed key LAST, not in the slot it first appeared", () => {
    // Ordering is information: the newest curve state must be the one applied
    // last, or an older snapshot can overwrite a newer one.
    const f = frames();
    const flushes: string[][] = [];
    const b = batchByFrame<string>((i) => flushes.push(i), {
      key: (s) => s[0]!,
      schedule: f.schedule,
      cancel: f.cancel,
    });
    b.push("A1");
    b.push("B1");
    b.push("A2");
    f.tick();
    expect(flushes[0]).toEqual(["B1", "A2"]);
  });

  it("stays bounded in a hidden tab, where frames never come", () => {
    // requestAnimationFrame does not fire in a background tab. Unkeyed, the
    // buffer would grow for as long as the tab stays hidden.
    const f = frames();
    const b = batchByFrame<number>(() => {}, {
      schedule: f.schedule,
      cancel: f.cancel,
      maxBuffered: 100,
    });
    for (let i = 0; i < 10_000; i++) b.push(i);
    expect(b.size).toBe(100);
  });

  it("keyed buffers are bounded by the key space, not by the event rate", () => {
    const f = frames();
    const b = batchByFrame<number>(() => {}, {
      key: (n) => String(n % 7),
      schedule: f.schedule,
      cancel: f.cancel,
    });
    for (let i = 0; i < 10_000; i++) b.push(i);
    expect(b.size).toBe(7);
  });

  it("flush() delivers immediately and cancels the pending frame", () => {
    const f = frames();
    const flushes: number[][] = [];
    const b = batchByFrame<number>((i) => flushes.push(i), { schedule: f.schedule, cancel: f.cancel });
    b.push(1);
    b.flush();
    expect(flushes).toEqual([[1]]);
    expect(f.scheduled).toBe(false);
    f.tick();
    expect(flushes).toHaveLength(1); // no empty second flush
  });

  it("stop() drops the buffer, so an unmounted screen cannot set state", () => {
    const f = frames();
    const flushes: number[][] = [];
    const b = batchByFrame<number>((i) => flushes.push(i), { schedule: f.schedule, cancel: f.cancel });
    b.push(1);
    b.stop();
    f.tick();
    b.push(2);
    f.tick();
    expect(flushes).toEqual([]);
  });
});
