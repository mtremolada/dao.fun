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

export const DEFAULT_RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com";

const LS_KEY = "daofun.rpcUrl";

export function getRpcUrl(): string {
  if (typeof window !== "undefined") {
    const stored = window.localStorage.getItem(LS_KEY);
    if (stored && stored.length > 0) return stored;
  }
  return DEFAULT_RPC_URL;
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
