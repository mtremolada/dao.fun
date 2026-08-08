"use client";

import { isDevnet } from "../lib/cluster";

/**
 * Persistent devnet notice, mirroring Phantom's own testnet banner. Makes it
 * unmistakable that nothing here has monetary value — a MUST for a public
 * testnet demo.
 */
export function DevnetBanner() {
  if (!isDevnet()) return null;
  return (
    <div className="devnet-banner" role="note">
      You are on <strong>Solana Devnet</strong> — coins here are for testing and have{" "}
      <strong>no real value</strong>.
    </div>
  );
}
