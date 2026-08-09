/**
 * Client for the launchpad backend (board/coin/trades/candles/metadata/airdrop
 * + the SSE live feed). Read-path only: every transaction is still built in the
 * browser and sent through our RPC, so the app keeps working (just without the
 * live board) if the backend is down.
 */
const API = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export interface CoinView {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  virtualSol: string;
  virtualToken: string;
  realSol: string;
  realToken: string;
  complete: boolean;
  migrated: boolean;
  poolState: string | null;
  createdBlockTime: number | null;
  progressBps: number;
}

export interface TradeView {
  signature: string;
  mint: string;
  trader: string;
  isBuy: boolean;
  tokenAmount: string;
  solAmount: string;
  virtualSol: string;
  virtualToken: string;
  slot: number;
  blockTime: number | null;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function apiConfigured(): boolean {
  return API.length > 0;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

export const launchpadApi = {
  board: (filter: "new" | "graduating" | "graduated" = "new") =>
    getJson<{ coins: CoinView[] }>(`/launchpad/board?filter=${filter}`).then((r) => r.coins),
  coin: (mint: string) => getJson<{ coin: CoinView }>(`/launchpad/coins/${mint}`).then((r) => r.coin),
  trades: (mint: string) =>
    getJson<{ trades: TradeView[] }>(`/launchpad/coins/${mint}/trades`).then((r) => r.trades),
  candles: (mint: string, res = 60) =>
    getJson<{ candles: Candle[] }>(`/launchpad/coins/${mint}/candles?res=${res}`).then((r) => r.candles),

  async uploadMetadata(input: {
    name: string;
    symbol: string;
    description: string;
    imageBase64: string;
    imageMime: string;
  }): Promise<{ uri: string; imageUri: string }> {
    const res = await fetch(`${API}/launchpad/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) throw new Error(`metadata upload failed (${res.status})`);
    return (await res.json()) as { uri: string; imageUri: string };
  },

  async airdrop(pubkey: string): Promise<{ signature?: string; fallback?: string; error?: string }> {
    const res = await fetch(`${API}/launchpad/airdrop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey }),
    });
    return (await res.json()) as { signature?: string; fallback?: string; error?: string };
  },

  /** The browser RPC endpoint (our proxy) if the backend exposes one. */
  rpcUrl(): string | null {
    return apiConfigured() ? `${API}/rpc/devnet` : null;
  },
};

export type FeedStatus = "connecting" | "open" | "reconnecting";

export interface SubscribeOptions {
  /**
   * Called on every (re)connection, including the first.
   *
   * This is the correctness half of the feed. A stream that drops has a HOLE
   * in it, and a hole in a trade tape is invisible — it looks like a quiet
   * minute. Rather than trying to replay the gap (which needs a server-side
   * event log we do not keep, and which is only ever as good as its retention
   * window), the client RE-READS state on every connect. A resync cannot have
   * a gap by construction; a replay window can.
   */
  onResync?: () => void;
  onStatus?: (s: FeedStatus) => void;
  /** Seams, so the reconnect policy is testable without a network. */
  EventSourceImpl?: typeof EventSource;
  setTimeoutImpl?: (cb: () => void, ms: number) => number;
  clearTimeoutImpl?: (h: number) => void;
  random?: () => number;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribe to the live event feed.
 *
 * EventSource reconnects on its own, but on a fixed timer every client shares:
 * when the server restarts, every viewer comes back at the same instant and
 * the herd finishes what the restart started. So the retry is managed here
 * instead — exponential, and JITTERED, which is the part that actually
 * spreads the herd out.
 *
 * Returns an unsubscribe function; a no-op when the API or EventSource is
 * unavailable.
 */
export function subscribeLaunchpad(
  onEvent: (kind: string, data: unknown) => void,
  opts: SubscribeOptions = {},
): () => void {
  const ES = opts.EventSourceImpl ?? (typeof EventSource !== "undefined" ? EventSource : undefined);
  if (!apiConfigured() || !ES) return () => {};

  const setT = opts.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const clearT = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const random = opts.random ?? Math.random;
  const kinds = ["launchpad:create", "launchpad:trade", "launchpad:complete", "launchpad:migrate"];

  let stopped = false;
  let attempt = 0;
  let es: EventSource | null = null;
  let timer: number | null = null;

  const connect = () => {
    if (stopped) return;
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    const source = new ES(`${API}/launchpad/events`);
    es = source;

    source.onopen = () => {
      if (stopped) return;
      attempt = 0;
      opts.onStatus?.("open");
      // Every connect, not just reconnects: the first one also needs the
      // state that existed before the stream started.
      opts.onResync?.();
    };

    for (const k of kinds) {
      source.addEventListener(k, ((e: MessageEvent) => {
        if (stopped) return;
        try {
          onEvent(k, JSON.parse(e.data));
        } catch {
          /* ignore malformed frame */
        }
      }) as EventListener);
    }

    source.onerror = () => {
      if (stopped) return;
      // Close before scheduling: EventSource would otherwise retry on its own
      // timer as well, and we would hold two connections per client.
      source.close();
      if (es === source) es = null;
      const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
      attempt += 1;
      // Full jitter. Half of a synchronised herd retrying at the same
      // millisecond is still a herd; a uniform draw over [0, backoff) is what
      // actually spreads them across the window.
      const delay = Math.floor(random() * backoff);
      opts.onStatus?.("reconnecting");
      timer = setT(connect, delay);
    };
  };

  connect();

  return () => {
    stopped = true;
    if (timer !== null) clearT(timer);
    es?.close();
    es = null;
  };
}
