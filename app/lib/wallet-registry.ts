/**
 * Pure helpers behind the universal wallet connect: persistence of the
 * last-used wallet (so a session "stays connected" across reloads), the
 * eager-reconnect decision, display formatting, and the curated install
 * list shown when a popular wallet is not yet detected. No React, no DOM
 * beyond a guarded localStorage read — all unit-tested offline.
 */
import type { StandardWalletLike } from "./wallet-standard";

const STORAGE_KEY = "daofun:last-wallet";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // localStorage can throw in sandboxed/SSR contexts — degrade quietly.
    return null;
  }
}

export function loadLastWalletName(): string | null {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveLastWalletName(name: string): void {
  try {
    storage()?.setItem(STORAGE_KEY, name);
  } catch {
    /* private-mode / quota — connection still works, it just won't persist */
  }
}

export function clearLastWalletName(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The wallet to silently reconnect to on load: the last-used one, but only
 * once it has actually registered (extensions inject asynchronously, so an
 * absent match means "wait", not "give up").
 */
export function pickEagerWallet(
  wallets: StandardWalletLike[],
  lastName: string | null,
): StandardWalletLike | undefined {
  if (!lastName) return undefined;
  return wallets.find((w) => w.name === lastName);
}

/** Stable testid/key slug for a wallet name ("E2E Fake Wallet" -> "e2e-fake-wallet"). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Address pill: "GRdk…t8wR". Short strings pass through unchanged. */
export function truncateAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export interface InstallOption {
  name: string;
  url: string;
}

/**
 * The wallet(s) we support for now — Phantom only. Detected wallets are
 * filtered to this allowlist.
 */
export const ALLOWED_WALLET_NAMES = ["Phantom"] as const;

/** Detected wallet-standard wallets, restricted to the allowlist. */
export function allowedDetected(
  wallets: StandardWalletLike[],
): StandardWalletLike[] {
  const allow = new Set(
    ALLOWED_WALLET_NAMES.map((n) => n.toLowerCase()),
  );
  return wallets.filter((w) => allow.has(w.name.toLowerCase()));
}

/** Install links for the supported wallet(s). */
export const KNOWN_WALLETS: readonly InstallOption[] = [
  { name: "Phantom", url: "https://phantom.app/download" },
];

/** Supported browser wallets that are NOT already detected (case-insensitive). */
export function installOptions(detected: StandardWalletLike[]): InstallOption[] {
  const have = new Set(detected.map((w) => w.name.toLowerCase()));
  return KNOWN_WALLETS.filter((k) => !have.has(k.name.toLowerCase()));
}
