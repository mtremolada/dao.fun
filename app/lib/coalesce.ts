/**
 * One state commit per frame, not one per event.
 *
 * A push feed does not arrive politely. During a launch the board can take
 * tens of updates a second, and the naive shape — `setState` per push —
 * re-renders the whole board that many times, each render re-bucketing and
 * re-sorting every column. The screen cannot show more than one frame per
 * frame, so every render beyond the first in a frame is pure waste, and it is
 * waste paid exactly when the site is busiest.
 *
 * Two properties make this more than a debounce:
 *
 *  - **Latency is unchanged.** A debounce delays the first update; this one
 *    still lands on the very next frame. The user sees the same thing at the
 *    same time, for a fraction of the work.
 *  - **It is bounded.** With a `key`, only the newest item per key survives —
 *    a coin's older curve state is superseded, not queued. That matters in a
 *    background tab, where `requestAnimationFrame` stops firing entirely and
 *    an unkeyed queue would grow for as long as the tab stays hidden.
 */

export interface Batcher<T> {
  push(item: T): void;
  /** Deliver whatever is buffered right now. */
  flush(): void;
  /** Stop delivering; a pending frame is cancelled. */
  stop(): void;
  /** Buffered item count — for tests and telemetry. */
  readonly size: number;
}

export interface BatchOptions<T> {
  /** Collapse items sharing a key, keeping the newest. */
  key?: (item: T) => string;
  /** Injectable for tests; defaults to requestAnimationFrame where present. */
  schedule?: (cb: () => void) => number;
  cancel?: (handle: number) => void;
  /**
   * Hard cap on the buffer when there is no key to collapse on. Reached only
   * in a tab that has been hidden for a long time under a heavy feed; the
   * oldest are dropped, because the newest are what the screen will show.
   */
  maxBuffered?: number;
}

const defaultSchedule = (cb: () => void): number =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => cb())
    : (setTimeout(cb, 16) as unknown as number);

const defaultCancel = (h: number): void => {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(h);
  else clearTimeout(h as unknown as ReturnType<typeof setTimeout>);
};

export function batchByFrame<T>(
  onFlush: (items: T[]) => void,
  opts: BatchOptions<T> = {},
): Batcher<T> {
  const schedule = opts.schedule ?? defaultSchedule;
  const cancel = opts.cancel ?? defaultCancel;
  const cap = opts.maxBuffered ?? 5_000;

  // A Map preserves insertion order, so a keyed buffer stays chronological
  // while still collapsing repeats — order matters for a trade tape.
  const keyed = new Map<string, T>();
  const list: T[] = [];
  let handle: number | null = null;
  let stopped = false;

  const drain = (): T[] => {
    if (opts.key) {
      const out = [...keyed.values()];
      keyed.clear();
      return out;
    }
    return list.splice(0, list.length);
  };

  const flush = () => {
    handle = null;
    if (stopped) return;
    const items = drain();
    if (items.length > 0) onFlush(items);
  };

  return {
    push(item: T) {
      if (stopped) return;
      if (opts.key) {
        const k = opts.key(item);
        // Delete first so a re-pushed key moves to the END: the newest state
        // for a coin should be applied last, not in the slot where that coin
        // was first seen.
        keyed.delete(k);
        keyed.set(k, item);
      } else {
        list.push(item);
        if (list.length > cap) list.splice(0, list.length - cap);
      }
      if (handle === null) handle = schedule(flush);
    },
    flush() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      flush();
    },
    stop() {
      stopped = true;
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      keyed.clear();
      list.length = 0;
    },
    get size() {
      return opts.key ? keyed.size : list.length;
    },
  };
}
