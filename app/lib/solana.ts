/**
 * Client-side RPC, the way a normal dapp does it: a public default that the
 * user can override (?rpc= once, then persisted), with NO server in the
 * loop. Transactions are SENT through the connected wallet's own RPC
 * (signAndSendTransaction); this Connection is only for reads and blockhash.
 */
import { Connection, clusterApiUrl } from "@solana/web3.js";

const RPC_KEY = "daofun:rpc";

/** Build-time default for a deployment; falls back to public mainnet. */
const DEFAULT_RPC =
  process.env.NEXT_PUBLIC_RPC_URL || clusterApiUrl("mainnet-beta");

export function getRpcUrl(): string {
  if (typeof window === "undefined") return DEFAULT_RPC;
  try {
    const fromQuery = new URL(window.location.href).searchParams.get("rpc");
    if (fromQuery) {
      window.localStorage?.setItem(RPC_KEY, fromQuery);
      return fromQuery;
    }
    return window.localStorage?.getItem(RPC_KEY) || DEFAULT_RPC;
  } catch {
    return DEFAULT_RPC;
  }
}

export function setRpcUrl(url: string): void {
  try {
    window.localStorage?.setItem(RPC_KEY, url);
  } catch {
    /* ignore */
  }
}

export function getConnection(): Connection {
  return new Connection(getRpcUrl(), "confirmed");
}

/** wallet-standard chain id derived from the read RPC, for signAndSend. */
export function solanaChain(): `solana:${string}` {
  const url = getRpcUrl().toLowerCase();
  if (url.includes("devnet")) return "solana:devnet";
  if (url.includes("testnet")) return "solana:testnet";
  return "solana:mainnet";
}
