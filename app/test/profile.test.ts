/**
 * Profile logic: the claimable figure must match what the program would
 * actually pay (balance minus the rent floor it keeps), and the launch list
 * must be filtered/ordered the way the screen renders it.
 */
import { describe, expect, it } from "vitest";
import { CURVE_ACCOUNT_LEN, CURVE_CREATOR_OFFSET, claimableFromVault } from "../lib/profile";

describe("claimableFromVault", () => {
  it("subtracts the rent floor the program retains", () => {
    // 0.5 SOL parked, 890880 lamports must stay behind.
    expect(claimableFromVault(500_000_000, 890_880)).toBe(499_109_120n);
  });

  it("reports nothing when the vault holds only its rent floor", () => {
    expect(claimableFromVault(890_880, 890_880)).toBe(0n);
  });

  it("never reports a negative claim for an under-funded vault", () => {
    expect(claimableFromVault(0, 890_880)).toBe(0n);
    expect(claimableFromVault(100, 890_880)).toBe(0n);
  });
});

describe("curve account filter constants", () => {
  it("puts creator right after the discriminator and mint", () => {
    expect(CURVE_CREATOR_OFFSET).toBe(40);
  });

  it("matches the DEPLOYED BondingCurve size, trailing bump included", () => {
    // 8 disc + mint + creator + 4 u64 + 2 u16 + complete + migrated + pool
    // + bump. Measured on devnet: real curve accounts are 143 bytes, and the
    // 277-byte Config also matches the creator memcmp (its fee recipient sits
    // at the same offset), so this size filter is what keeps them apart.
    expect(CURVE_ACCOUNT_LEN).toBe(143);
  });
});
