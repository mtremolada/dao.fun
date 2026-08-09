/**
 * The launchpad HTTP surface — a bare node:http RequestListener built by
 * dependency injection, the same shape as the DAO `createApiHandler` so the
 * same handler runs in tests, dev, and prod. Every capability is optional and
 * returns 501 when its dep is absent, so tests wire only what they exercise.
 *
 * Routes:
 *   GET  /health
 *   GET  /launchpad/board?filter=new|graduating|graduated&limit=
 *   GET  /launchpad/coins/:mint
 *   GET  /launchpad/coins/:mint/trades?limit=
 *   GET  /launchpad/coins/:mint/candles?res=
 *   GET  /launchpad/events                (SSE)
 *   GET  /launchpad/meta/:file            (self-hosted metadata assets)
 *   POST /launchpad/metadata              (image+json upload)
 *   POST /launchpad/airdrop               (devnet SOL to a pubkey)
 *   POST /rpc/devnet                      (allowlisted JSON-RPC proxy)
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { PublicKey } from "@solana/web3.js";
import type { SqliteLaunchpadStore, CoinRow, TradeRow } from "./store";
import type { SseHub } from "./sse";
import { Cooldown, TokenBucket } from "./ratelimit";
import { toPrometheus, type Metrics } from "./metrics";

export interface MetadataUploadInput {
  name: string;
  symbol: string;
  description: string;
  image: Buffer;
  imageMime: string;
}
export interface MetadataUploader {
  upload(input: MetadataUploadInput): Promise<{ uri: string; imageUri: string }>;
}

export interface RpcProxyDeps {
  upstreamUrl: string;
  fetchImpl?: typeof fetch;
  /** Methods the browser is allowed to call through us. */
  allowedMethods?: string[];
  ratePerSecond?: number;
  burst?: number;
}

export interface AirdropDeps {
  requestAirdrop: (pubkey: string, lamports: number) => Promise<string>;
  solPerRequest?: number;
  cooldownMs?: number;
  dailyCap?: number;
  faucetUrl?: string;
}

export interface LaunchpadHandlerDeps {
  store: SqliteLaunchpadStore;
  sse?: SseHub;
  rpcProxy?: RpcProxyDeps;
  airdrop?: AirdropDeps;
  metadata?: { uploader: MetadataUploader; maxImageBytes?: number };
  /** Directory self-hosted metadata assets are served from (GET /launchpad/meta/*). */
  metadataDir?: string;
  /** Extra fields merged into /health. */
  healthExtra?: () => Record<string, unknown>;
  /** Serves GET /metrics. Absent → the route reports 501 rather than lying. */
  metrics?: Metrics;
}

const DEFAULT_ALLOWED_RPC_METHODS = [
  "getLatestBlockhash",
  "getBlockHeight",
  "sendTransaction",
  "simulateTransaction",
  "getSignatureStatuses",
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "getTokenLargestAccounts",
  "getFeeForMessage",
  "getGenesisHash",
  // The client prices its priority fee from this (app/lib/fees.ts). Without
  // it here the proxy answers 403, the estimator silently falls back to the
  // constant, and the dynamic fee quietly stops existing behind the API.
  "getRecentPrioritizationFees",
];

const METADATA_MAX_BYTES = 8 * 1024 * 1024;
const JSON_MAX_BYTES = 256 * 1024;
const IMAGE_MIME_ALLOW = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readRawBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > cap) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket.remoteAddress ?? "unknown";
}

function isPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function coinView(c: CoinRow) {
  const initialRealToken = 793_100_000_000_000; // display progress denominator (pump-classic)
  const sold = initialRealToken - Number(BigInt(c.realToken));
  return {
    mint: c.mint,
    name: c.name,
    symbol: c.symbol,
    uri: c.uri,
    creator: c.creator,
    virtualSol: c.virtualSol,
    virtualToken: c.virtualToken,
    realSol: c.realSol,
    realToken: c.realToken,
    complete: c.complete === 1,
    migrated: c.migrated === 1,
    poolState: c.poolState,
    createdBlockTime: c.createdBlockTime,
    // Best-effort progress for the board; the client recomputes precisely from
    // the on-chain config denominator when it has it.
    progressBps: c.migrated === 1 ? 10_000 : Math.max(0, Math.min(10_000, Math.round((sold / initialRealToken) * 10_000))),
  };
}

function tradeView(t: TradeRow) {
  return {
    signature: t.signature,
    mint: t.mint,
    trader: t.trader,
    isBuy: t.isBuy === 1,
    tokenAmount: t.tokenAmount,
    solAmount: t.solAmount,
    virtualSol: t.virtualSol,
    virtualToken: t.virtualToken,
    slot: t.slot,
    blockTime: t.blockTime,
  };
}

export function createLaunchpadHandler(deps: LaunchpadHandlerDeps): RequestListener {
  const rpcBucket = deps.rpcProxy
    ? new TokenBucket(deps.rpcProxy.burst ?? 30, deps.rpcProxy.ratePerSecond ?? 10)
    : null;
  const airdropCooldown = new Cooldown();

  return (req, res) => {
    handle(req, res, deps, rpcBucket, airdropCooldown).catch((e) => {
      json(res, 500, { error: (e as Error).message });
    });
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: LaunchpadHandlerDeps,
  rpcBucket: TokenBucket | null,
  airdropCooldown: Cooldown,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      indexedSlot: deps.store.maxSlot(),
      sseClients: deps.sse?.size ?? 0,
      ...(deps.healthExtra?.() ?? {}),
    });
  }

  // GET /metrics[?format=prom]
  if (method === "GET" && url.pathname === "/metrics") {
    if (!deps.metrics) return json(res, 501, { error: "metrics not configured" });
    const snap = await deps.metrics.snapshot();
    if (url.searchParams.get("format") === "prom") {
      const body = toPrometheus(snap);
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    return json(res, 200, snap);
  }

  // GET /launchpad/board
  if (method === "GET" && seg[0] === "launchpad" && seg[1] === "board") {
    const filter = (url.searchParams.get("filter") ?? "new") as "new" | "graduating" | "graduated";
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const coins = deps.store.listCoins({ filter, limit }).map(coinView);
    return json(res, 200, { coins });
  }

  // GET /launchpad/coins/:mint[/trades|/candles]
  if (method === "GET" && seg[0] === "launchpad" && seg[1] === "coins" && seg[2]) {
    const mint = seg[2];
    if (!isPubkey(mint)) return json(res, 400, { error: "invalid mint" });
    if (seg[3] === "trades") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return json(res, 200, { trades: deps.store.listTrades(mint, limit).map(tradeView) });
    }
    if (seg[3] === "candles") {
      const resSec = Number(url.searchParams.get("res") ?? 60);
      return json(res, 200, { candles: deps.store.candles(mint, resSec) });
    }
    const coin = deps.store.getCoin(mint);
    if (!coin) return json(res, 404, { error: "coin not found" });
    return json(res, 200, { coin: coinView(coin) });
  }

  // GET /launchpad/events (SSE)
  if (method === "GET" && seg[0] === "launchpad" && seg[1] === "events") {
    if (!deps.sse) return json(res, 501, { error: "sse not configured" });
    deps.sse.subscribe(req, res);
    return;
  }

  // GET /launchpad/meta/:file  (self-hosted metadata assets)
  if (method === "GET" && seg[0] === "launchpad" && seg[1] === "meta" && seg[2]) {
    if (!deps.metadataDir) return json(res, 501, { error: "metadata hosting not configured" });
    const file = normalize(seg[2]).replace(/^(\.\.[/\\])+/, "");
    if (file.includes("/") || file.includes("\\")) return json(res, 400, { error: "bad path" });
    try {
      const buf = await readFile(join(deps.metadataDir, file));
      const type = file.endsWith(".json") ? "application/json" : file.endsWith(".webp") ? "image/webp" : "application/octet-stream";
      res.writeHead(200, {
        "content-type": type,
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(buf);
    } catch {
      json(res, 404, { error: "not found" });
    }
    return;
  }

  // POST /launchpad/metadata
  if (method === "POST" && seg[0] === "launchpad" && seg[1] === "metadata") {
    if (!deps.metadata) return json(res, 501, { error: "metadata upload not configured" });
    const cap = deps.metadata.maxImageBytes ?? METADATA_MAX_BYTES;
    let body: { name?: string; symbol?: string; description?: string; imageBase64?: string; imageMime?: string };
    try {
      body = JSON.parse((await readRawBody(req, cap + 64 * 1024)).toString("utf8"));
    } catch (e) {
      return json(res, 413, { error: (e as Error).message });
    }
    if (!body.name || !body.symbol || !body.imageBase64 || !body.imageMime) {
      return json(res, 400, { error: "name, symbol, imageBase64, imageMime required" });
    }
    if (!IMAGE_MIME_ALLOW.has(body.imageMime)) {
      return json(res, 415, { error: "unsupported image type" });
    }
    const image = Buffer.from(body.imageBase64, "base64");
    if (image.length === 0 || image.length > cap) {
      return json(res, 413, { error: "image too large or empty" });
    }
    const out = await deps.metadata.uploader.upload({
      name: body.name.slice(0, 32),
      symbol: body.symbol.slice(0, 10),
      description: (body.description ?? "").slice(0, 1000),
      image,
      imageMime: body.imageMime,
    });
    return json(res, 200, out);
  }

  // POST /launchpad/airdrop
  if (method === "POST" && seg[0] === "launchpad" && seg[1] === "airdrop") {
    if (!deps.airdrop) return json(res, 501, { error: "airdrop not configured" });
    const a = deps.airdrop;
    let body: { pubkey?: string };
    try {
      body = JSON.parse((await readRawBody(req, JSON_MAX_BYTES)).toString("utf8"));
    } catch {
      return json(res, 400, { error: "invalid body" });
    }
    if (!body.pubkey || !isPubkey(body.pubkey)) return json(res, 400, { error: "invalid pubkey" });
    const ip = clientIp(req);
    const cooldownMs = a.cooldownMs ?? 8 * 3600 * 1000;
    const fallback = { fallback: a.faucetUrl ?? "https://faucet.solana.com" };
    if (airdropCooldown.blocked(`ip:${ip}`, cooldownMs) || airdropCooldown.blocked(`pk:${body.pubkey}`, cooldownMs)) {
      return json(res, 429, { error: "cooldown active", ...fallback });
    }
    if (airdropCooldown.bumpDaily("airdrop", 86_400_000) > (a.dailyCap ?? 200)) {
      return json(res, 429, { error: "daily faucet cap reached", ...fallback });
    }
    try {
      const lamports = Math.round((a.solPerRequest ?? 1) * 1e9);
      const signature = await a.requestAirdrop(body.pubkey, lamports);
      airdropCooldown.mark(`ip:${ip}`);
      airdropCooldown.mark(`pk:${body.pubkey}`);
      return json(res, 200, { signature });
    } catch (e) {
      return json(res, 502, { error: (e as Error).message, ...fallback });
    }
  }

  // POST /rpc/devnet  (allowlisted JSON-RPC proxy; key stays server-side)
  if (method === "POST" && seg[0] === "rpc") {
    if (!deps.rpcProxy || !rpcBucket) return json(res, 501, { error: "rpc proxy not configured" });
    const ip = clientIp(req);
    // Every outcome is counted, including the refusals — a spike in refused
    // calls is the signal that someone is probing, and counting only the
    // successes would hide exactly that.
    const count = (ok: boolean) => deps.metrics?.rpcProxyCall(ok);
    if (!rpcBucket.take(ip)) {
      count(false);
      return json(res, 429, { error: "rate limited" });
    }
    let body: unknown;
    try {
      body = JSON.parse((await readRawBody(req, JSON_MAX_BYTES)).toString("utf8"));
    } catch {
      count(false);
      return json(res, 400, { error: "invalid json-rpc body" });
    }
    const allow = new Set(deps.rpcProxy.allowedMethods ?? DEFAULT_ALLOWED_RPC_METHODS);
    const calls = Array.isArray(body) ? body : [body];
    for (const c of calls) {
      const m = (c as { method?: unknown }).method;
      if (typeof m !== "string" || !allow.has(m)) {
        count(false);
        return json(res, 403, { error: `method not allowed: ${String(m)}` });
      }
    }
    const doFetch = deps.rpcProxy.fetchImpl ?? fetch;
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await doFetch(deps.rpcProxy.upstreamUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      count(false);
      return json(res, 502, { error: (e as Error).message });
    }
    count(upstream.ok);
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(text);
    return;
  }

  json(res, 404, { error: "not found" });
}
