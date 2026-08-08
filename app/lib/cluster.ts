/**
 * Single source of cluster truth for the app. Everything cluster-dependent —
 * the wallet-standard chain id, explorer links, the launchpad program id, and
 * which Raydium address set migration uses — resolves from NEXT_PUBLIC_CLUSTER,
 * so flipping to mainnet later is one env change, not a code hunt.
 */
import { PublicKey } from "@solana/web3.js";

export type Cluster = "devnet" | "mainnet" | "testnet";

export function cluster(): Cluster {
  const c = (process.env.NEXT_PUBLIC_CLUSTER ?? "devnet").toLowerCase();
  if (c === "mainnet" || c === "mainnet-beta") return "mainnet";
  if (c === "testnet") return "testnet";
  return "devnet";
}

export function isDevnet(): boolean {
  return cluster() !== "mainnet";
}

/** The wallet-standard chain id the wallet should broadcast on. */
export function chainId(): `solana:${string}` {
  const c = cluster();
  return c === "mainnet" ? "solana:mainnet" : `solana:${c}`;
}

/** The launchpad program id (minted at first devnet deploy; env in production). */
export function launchpadProgramId(): PublicKey {
  return new PublicKey(
    process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID ??
      "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr",
  );
}

const EXPLORER_SUFFIX: Record<Cluster, string> = {
  devnet: "?cluster=devnet",
  testnet: "?cluster=testnet",
  mainnet: "",
};

/** Centralized explorer links — a mainnet flip changes only the suffix table. */
export function explorerTx(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${EXPLORER_SUFFIX[cluster()]}`;
}
export function explorerAddress(address: string): string {
  return `https://explorer.solana.com/address/${address}${EXPLORER_SUFFIX[cluster()]}`;
}

/** Per-wallet instructions for pointing a wallet at devnet (the broadcast trap). */
export const ENABLE_DEVNET_HINTS: { wallet: string; steps: string }[] = [
  { wallet: "Phantom", steps: "Settings → Developer Settings → Testnet Mode → Solana Devnet" },
  { wallet: "Solflare", steps: "Settings → Network → Devnet" },
  { wallet: "Backpack", steps: "Settings → Developer Mode → then select Devnet" },
];
