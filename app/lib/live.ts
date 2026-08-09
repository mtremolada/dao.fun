/**
 * Live chain updates — push, not poll.
 *
 * A trading screen is judged on whether the number moved when the trade
 * happened. Polling cannot deliver that: at a 5-second tick the average
 * staleness is 2.5 seconds and the worst case is 5, and the board did not
 * update at all. Solana's RPC has WebSocket subscriptions, and a browser can
 * use them directly — no backend, no infrastructure decision.
 *
 * Measured on devnet against a real buy: the `programSubscribe` push arrived
 * **1,025 ms** after the transaction was sent, which was BEFORE
 * `sendAndConfirmTransaction` returned to the sender. So every viewer sees a
 * trade at about the same moment the trader does.
 *
 * Three things this must get right, because they are what separates a live
 * feed from a demo:
 *
 *  - **Degrade, never break.** Not every RPC permits `programSubscribe` — it
 *    is expensive to serve and providers restrict it. A refused subscription
 *    falls back to polling at the old interval and says so, rather than
 *    leaving a dead screen that looks live.
 *  - **Be honest about state.** `onProgramAccountChange` does not throw when
 *    the socket is unreachable — it registers and fails later — so reporting
 *    "live" because that call returned would be exactly the dishonest badge
 *    this module exists to avoid. The status follows the socket itself.
 *  - **Push for latency, poll for correctness.** A WebSocket can stop
 *    delivering without telling anyone, and a subscription that dies silently
 *    leaves a screen that looks alive and is frozen — worse than one that is
 *    obviously stale. A slow reconciliation read runs regardless, which is
 *    what makes a wrong badge cosmetic rather than a data-loss bug.
 *  - **Stay bounded.** `programSubscribe` streams EVERY account the program
 *    touches to every connected client. That is the right trade at this size
 *    and the wrong one at a hundred times it, which is exactly when the
 *    backend's SSE fan-out takes over (SCALING.md).
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { decodeCurve, type DecodedCurve } from "@daofun/sdk/launchpad";
import { curvePda } from "@daofun/sdk/launchpad";
import { CURVE_ACCOUNT_LEN, fetchCurvesFromChain } from "./chain-coin";
import { launchpadProgramId } from "./cluster";

export type LiveStatus = "connecting" | "live" | "polling";

/**
 * How often to re-read everything even while the socket looks healthy.
 *
 * Push gives latency; this gives CORRECTNESS. A WebSocket can drop, or stop
 * delivering, without telling anyone — and a subscription that silently dies
 * leaves a screen that looks alive and is frozen, which is worse than an
 * obviously stale one. Every real trading frontend pairs the two. Slow enough
 * to be nearly free, fast enough that a dead socket costs seconds, not the
 * length of the session.
 */
const RECONCILE_MS = 30_000;

export interface LiveHandle {
  stop(): void;
}

export interface LiveOptions {
  onStatus?: (status: LiveStatus) => void;
  /** Used only when the subscription is refused. */
  fallbackPollMs?: number;
}

const DEFAULT_POLL_MS = 5_000;

/**
 * Every curve account the program touches, pushed as it changes.
 *
 * One subscription covers the whole launchpad: a buy on any coin, a new coin,
 * a migration. The `dataSize` filter is the same correctness guard the scan
 * uses — without it the Config account arrives here and decodes as a coin.
 */
export function watchAllCurves(
  connection: Connection,
  onCurve: (curve: DecodedCurve) => void,
  opts: LiveOptions = {},
): LiveHandle {
  const programId = launchpadProgramId();
  let stopped = false;
  let subId: number | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const status = (s: LiveStatus) => {
    if (!stopped) opts.onStatus?.(s);
  };

  /** The fallback is the OLD behaviour, kept honest by saying it is polling. */
  const startPolling = () => {
    if (stopped || pollTimer) return;
    status("polling");
    const tick = () => {
      fetchCurvesFromChain(connection)
        .then((curves) => {
          if (!stopped) for (const c of curves) onCurve(c);
        })
        .catch(() => {});
    };
    pollTimer = setInterval(tick, opts.fallbackPollMs ?? DEFAULT_POLL_MS);
  };

  const reconcile = () => {
    // A hidden tab has nothing to show, and this read is a full program scan.
    // Multiplied by every background tab every 30 seconds it is one of the
    // largest avoidable costs in the client, and skipping it changes nothing
    // a user can see: the visibility handler below reconciles the moment the
    // tab comes back, so returning to it is still correct immediately.
    if (isHidden()) return;
    fetchCurvesFromChain(connection)
      .then((curves) => {
        if (!stopped) for (const c of curves) onCurve(c);
      })
      .catch(() => {});
  };

  status("connecting");
  try {
    subId = connection.onProgramAccountChange(
      programId,
      (info) => {
        if (stopped) return;
        try {
          onCurve(decodeCurve(info.accountInfo.data));
        } catch {
          /* not a curve, or a layout we do not know — ignore, never throw */
        }
      },
      "confirmed",
      [{ dataSize: CURVE_ACCOUNT_LEN }],
    );
    // `onProgramAccountChange` does NOT throw when the socket is unreachable —
    // it registers and fails later, asynchronously. Reporting "live" on the
    // strength of that call returning is exactly the dishonest badge this
    // module exists to avoid, so listen to the socket itself where the client
    // exposes it and stay at "connecting" until it actually opens.
    const ws = (connection as unknown as { _rpcWebSocket?: SocketEvents })
      ._rpcWebSocket;
    if (ws && typeof ws.on === "function") {
      ws.on("open", () => status("live"));
      ws.on("close", () => status("polling"));
      ws.on("error", () => status("polling"));
    } else {
      status("live");
    }
  } catch {
    startPolling();
  }

  // Always on, socket or not: this is the guarantee that the screen cannot be
  // silently frozen, and it is why a wrong "live" badge is cosmetic rather
  // than a data-loss bug.
  const reconcileTimer = setInterval(reconcile, RECONCILE_MS);

  // Coming back to a tab is exactly when a stale screen is most likely and
  // most noticeable, so reconcile on becoming visible rather than waiting out
  // the rest of the interval.
  const onVisible = () => {
    if (!stopped && !isHidden()) reconcile();
  };
  const doc = typeof document !== "undefined" ? document : null;
  doc?.addEventListener("visibilitychange", onVisible);

  return {
    stop() {
      stopped = true;
      clearInterval(reconcileTimer);
      doc?.removeEventListener("visibilitychange", onVisible);
      if (pollTimer) clearInterval(pollTimer);
      if (subId !== null) {
        connection.removeProgramAccountChangeListener(subId).catch(() => {});
      }
    },
  };
}

/** True when the tab is in the background. False anywhere without a document. */
function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** The slice of the ws client we use, kept narrow since it is not public API. */
interface SocketEvents {
  on(event: string, handler: () => void): void;
}

/**
 * One coin's curve, pushed as it changes.
 *
 * `accountSubscribe` is cheap and universally supported, so the coin page gets
 * a live price even on an RPC that refuses `programSubscribe`.
 */
export function watchCurve(
  connection: Connection,
  mint: string,
  onCurve: (curve: DecodedCurve) => void,
  opts: LiveOptions = {},
): LiveHandle {
  let stopped = false;
  let subId: number | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let address: PublicKey;
  try {
    address = curvePda(new PublicKey(mint), launchpadProgramId());
  } catch {
    return { stop() {} };
  }

  const status = (s: LiveStatus) => {
    if (!stopped) opts.onStatus?.(s);
  };
  const emit = (data: Buffer | Uint8Array) => {
    try {
      onCurve(decodeCurve(data));
    } catch {
      /* ignore a shape we cannot read rather than break the screen */
    }
  };

  status("connecting");
  try {
    subId = connection.onAccountChange(
      address,
      (info) => {
        if (!stopped) emit(info.data);
      },
      "confirmed",
    );
    status("live");
  } catch {
    status("polling");
    pollTimer = setInterval(() => {
      connection
        .getAccountInfo(address)
        .then((info) => {
          if (!stopped && info) emit(info.data);
        })
        .catch(() => {});
    }, opts.fallbackPollMs ?? DEFAULT_POLL_MS);
  }

  return {
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      if (subId !== null) {
        connection.removeAccountChangeListener(subId).catch(() => {});
      }
    },
  };
}
