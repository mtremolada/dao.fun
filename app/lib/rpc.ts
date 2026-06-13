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

// NEXT_PUBLIC_RPC_URL may be a single endpoint or a comma-separated list
// (resilience: operators can ship fallbacks; the first is the default).
const DEFAULT_RPC_URLS = (
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
