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

/**
 * Subscribe to the live event feed. EventSource reconnects automatically, so a
 * dropped connection (Railway's 15-min cap) is transparent. Returns an
 * unsubscribe function; a no-op when the API or EventSource is unavailable.
 */
export function subscribeLaunchpad(
  onEvent: (kind: string, data: unknown) => void,
): () => void {
  if (!apiConfigured() || typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`${API}/launchpad/events`);
  const kinds = ["launchpad:create", "launchpad:trade", "launchpad:complete", "launchpad:migrate"];
  const handlers = kinds.map((k) => {
    const h = (e: MessageEvent) => {
      try {
        onEvent(k, JSON.parse(e.data));
      } catch {
        /* ignore malformed frame */
      }
    };
    es.addEventListener(k, h as EventListener);
    return { k, h };
  });
  return () => {
    for (const { k, h } of handlers) es.removeEventListener(k, h as EventListener);
    es.close();
  };
}
