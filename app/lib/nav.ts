"use client";

/**
 * Pure navigation helpers (D-033). The server-less site has no index/back end
 * to list DAOs, so the public navigates by address. These build the
 * trailing-slash query URLs the static export serves (`/dao/?…`,
 * `/proposal/?…`) and validate pubkeys client-side before navigating.
 */
import { PublicKey } from "@solana/web3.js";

export function isPubkey(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    void new PublicKey(t);
    return true;
  } catch {
    return false;
  }
}

export function daoHref(p: {
  realm: string;
  vault: string;
  mint?: string;
  wallet?: string;
}): string {
  const params = new URLSearchParams({
    realm: p.realm.trim(),
    vault: p.vault.trim(),
  });
  if (p.mint && p.mint.trim()) params.set("mint", p.mint.trim());
  if (p.wallet && p.wallet.trim()) params.set("wallet", p.wallet.trim());
  return `/dao/?${params.toString()}`;
}

export function proposalHref(id: string): string {
  return `/proposal/?id=${encodeURIComponent(id.trim())}`;
}
