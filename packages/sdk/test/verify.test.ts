/**
 * On-chain DAO verifier — the buyer's trust primitive. The reads are the same
 * spl-governance/spl-token/squads reads proven elsewhere; this pins the pure
 * logic: the advance-derived chain is reported correctly, missing accounts make
 * checks fail (never throw), and `ok` is the AND of every check.
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { deriveGovernanceChainFromMint, verifyDao } from "../src";

// A connection whose every account read misses — verifyDao must degrade to
// all-false without throwing.
const emptyConnection = {
  async getAccountInfo() {
    return null;
  },
  async getAccountInfoAndContext() {
    return { context: { slot: 0 }, value: null };
  },
  async getMultipleAccountsInfo() {
    return [null];
  },
} as unknown as Connection;

describe("verifyDao", () => {
  it("reports the advance-derived chain from the mint alone", async () => {
    const mint = Keypair.generate().publicKey;
    const v = await verifyDao(emptyConnection, mint);
    const chain = deriveGovernanceChainFromMint(mint);
    expect(v.realm).toBe(chain.realm.toBase58());
    expect(v.governance).toBe(chain.governance.toBase58());
    expect(v.nativeTreasury).toBe(chain.nativeTreasury.toBase58());
  });

  it("degrades to all-false (never throws) when nothing is on chain; ok=false", async () => {
    const v = await verifyDao(emptyConnection, Keypair.generate().publicKey);
    expect(v.ok).toBe(false);
    expect(Object.values(v.checks).some(Boolean)).toBe(false);
  });

  it("prompts for the multisigPda to complete the custody (INV-7) check", async () => {
    const v = await verifyDao(emptyConnection, Keypair.generate().publicKey);
    expect(v.notes.join(" ")).toMatch(/multisigPda/);
    // without it, the custody checks are simply absent (not silently 'true')
    expect(v.checks["multisigMemberIsNativeTreasury"]).toBeUndefined();
  });

  it("AUDIT-A: exposes config + riskFlags (degrades to null/empty unread)", async () => {
    const v = await verifyDao(emptyConnection, Keypair.generate().publicKey);
    // the fields exist (the verifier surfaces governance params, not just structure)
    expect(v).toHaveProperty("config");
    expect(v).toHaveProperty("riskFlags");
    // unread chain -> no config to judge, no spurious risk flags
    expect(v.config).toBeNull();
    expect(v.riskFlags).toEqual([]);
  });
});
