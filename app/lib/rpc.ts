"use client";

/**
 * Client RPC seam (D-033). In the server-less build there is no backend: the
 * browser talks to a Solana RPC directly. The endpoint is the user's choice —
 * a build-time default (NEXT_PUBLIC_RPC_URL) overridable at runtime and
 * persisted to localStorage — so the deployment is permissionless end to end
 * (bring your own RPC; the static host never sees a request).
 */
import { Connection } from "@solana/web3.js";
import { RpcChainReader } from "@daofun/sdk/chain-reader";
import { RpcGovernanceTxSource } from "@daofun/sdk/tx-builder";

// A keyless, CORS-enabled public endpoint always kept as a last-resort
// fallback so reads work out of the box even if the primary is rate-limited
// (verified reachable + serving the read path: scripts/verify-frontend-read).
const PUBLIC_FALLBACK_RPC = "https://solana-rpc.publicnode.com";

// NEXT_PUBLIC_RPC_URL may be a single endpoint or a comma-separated list
// (resilience: operators can ship fallbacks; the first is the default). The
// public fallback is appended unless already present.
const ENV_RPC_URLS = (
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_RPC_URLS = ENV_RPC_URLS.includes(PUBLIC_FALLBACK_RPC)
  ? ENV_RPC_URLS
  : [...ENV_RPC_URLS, PUBLIC_FALLBACK_RPC];

export const DEFAULT_RPC_URL =
  DEFAULT_RPC_URLS[0] ?? "https://api.mainnet-beta.solana.com";

const LS_KEY = "daofun.rpcUrl";

/** Endpoints to use, the user's saved override first. */
export function getRpcUrls(): string[] {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(LS_KEY);
    if (stored && stored.length > 0) {
      return [stored, ...DEFAULT_RPC_URLS.filter((u) => u !== stored)];
    }
  }
  return DEFAULT_RPC_URLS.length > 0 ? DEFAULT_RPC_URLS : [DEFAULT_RPC_URL];
}

export function getRpcUrl(): string {
  return getRpcUrls()[0] ?? DEFAULT_RPC_URL;
}

export function setRpcUrl(url: string): void {
  if (typeof window === "undefined") return;
  const trimmed = url.trim();
  if (trimmed.length === 0) window.localStorage.removeItem(LS_KEY);
  else window.localStorage.setItem(LS_KEY, trimmed);
}

export function getConnection(): Connection {
  return new Connection(getRpcUrl(), "confirmed");
}

export function getChainReader(): RpcChainReader {
  return new RpcChainReader(getConnection());
}

export function getTxSource(): RpcGovernanceTxSource {
  return new RpcGovernanceTxSource(getConnection());
}

/**
 * Run async producers in order; return the first non-null result. If every
 * producer either returned null or threw, rethrow the last error (only when
 * something threw) — a null from every endpoint means "genuinely not found".
 * Pure (no chain deps), so the fallback logic is unit-tested offline.
 */
export async function firstNonNull<T>(
  producers: Array<() => Promise<T | null>>,
): Promise<T | null> {
  let lastError: unknown = null;
  let threw = false;
  for (const produce of producers) {
    try {
      const result = await produce();
      if (result !== null) return result;
    } catch (e) {
      lastError = e;
      threw = true;
    }
  }
  if (threw) throw lastError;
  return null;
}

/**
 * Read the chain with RPC fallback: try each configured endpoint (user
 * override first) until one returns data. Survives a rate-limited or down
 * primary — the resilience seam every read page uses.
 */
export function readWithFallback<T>(
  fn: (reader: RpcChainReader) => Promise<T | null>,
): Promise<T | null> {
  return firstNonNull(
    getRpcUrls().map(
      (url) => () => fn(new RpcChainReader(new Connection(url, "confirmed"))),
    ),
  );
}
