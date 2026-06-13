/**
 * Holder-snapshot share math — the pure half of spec 6.8 `distribute`
 * ("backend snapshots holders at slot, builds tree"). The snapshot SOURCE
 * (RPC/DAS) lives in the backend; this module turns raw holder balances
 * into the ClaimShare[] the merkle tree is built from:
 *
 *   - pro-rata by held amount, floor division (Σ shares <= totalLamports;
 *     the dust remainder never leaves the vault — INV-6 checked math);
 *   - multiple token accounts of one owner aggregate to one claim
 *     (ClaimStatus PDAs are per-claimant, so duplicates could never claim);
 *   - the DAO's own accounts (vault, pool, treasury) are excludable;
 *   - zero balances and zero shares drop out (the distributor refuses
 *     zero-amount claims), and the output order is deterministic.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { proRataShares, type HolderBalance } from "../src/snapshot";
import { buildClaimTree } from "../src/merkle-distributor";

const U64_MAX = 2n ** 64n - 1n;

function holder(amount: bigint): HolderBalance {
  return { owner: Keypair.generate().publicKey, amount };
}

describe("proRataShares", () => {
  it("splits pro-rata with floor division; dust stays unallocated", () => {
    const holders = [holder(300n), holder(200n), holder(100n)];
    const r = proRataShares({ holders, totalLamports: 1_000_001n });
    // shares: floor(1000001 * 300/600), * 200/600, * 100/600
    expect(r.shares.map((s) => s.lamports).sort((a, b) => Number(a - b))).toEqual([
      166_666n, 333_333n, 500_000n,
    ]);
    expect(r.allocatedLamports).toBe(999_999n);
    expect(r.dustLamports).toBe(2n);
    expect(r.heldSupply).toBe(600n);
    expect(r.allocatedLamports + r.dustLamports).toBe(1_000_001n);
  });

  it("aggregates multiple token accounts of the same owner into ONE claim", () => {
    const owner = Keypair.generate().publicKey;
    const other = holder(500n);
    const r = proRataShares({
      holders: [
        { owner, amount: 300n },
        other,
        { owner, amount: 200n },
      ],
      totalLamports: 1_000n,
    });
    expect(r.shares).toHaveLength(2);
    const mine = r.shares.find((s) => s.claimant.equals(owner))!;
    expect(mine.lamports).toBe(500n); // 1000 * (300+200)/1000
    // a duplicate claimant would also be rejected downstream:
    expect(() => buildClaimTree(r.shares)).not.toThrow();
  });

  it("excludes the DAO's own accounts and drops zero balances + zero shares", () => {
    const vault = Keypair.generate().publicKey;
    const whale = holder(1_000_000n);
    const dustHolder = holder(1n); // floor(1000 * 1/...) == 0 -> dropped
    const zero = holder(0n);
    const r = proRataShares({
      holders: [{ owner: vault, amount: 9_000_000n }, whale, dustHolder, zero],
      totalLamports: 1_000n,
      excludeOwners: [vault],
    });
    // excluded owner is not in the denominator either
    expect(r.heldSupply).toBe(1_000_001n);
    expect(r.shares).toHaveLength(1);
    expect(r.shares[0]!.claimant.equals(whale.owner)).toBe(true);
    expect(r.shares.every((s) => s.lamports > 0n)).toBe(true);
  });

  it("is exact at u64 bounds (INV-6): no precision loss, never over-allocates", () => {
    const holders = [holder(U64_MAX - 1n), holder(1n)];
    const r = proRataShares({ holders, totalLamports: U64_MAX });
    expect(r.allocatedLamports <= U64_MAX).toBe(true);
    expect(r.shares[0]!.lamports + r.shares[1]!.lamports).toBe(
      r.allocatedLamports,
    );
    // the whale's share is total * (U64-1)/U64 == U64-1 exactly
    const whaleShare = r.shares.find((s) => s.lamports > 1n)!;
    expect(whaleShare.lamports).toBe(U64_MAX - 1n);
  });

  it("output is deterministic regardless of input order", () => {
    const a = holder(10n);
    const b = holder(20n);
    const c = holder(30n);
    const r1 = proRataShares({ holders: [a, b, c], totalLamports: 600n });
    const r2 = proRataShares({ holders: [c, a, b], totalLamports: 600n });
    expect(r1.shares.map((s) => s.claimant.toBase58())).toEqual(
      r2.shares.map((s) => s.claimant.toBase58()),
    );
    expect(buildClaimTree(r1.shares).root.equals(buildClaimTree(r2.shares).root)).toBe(
      true,
    );
  });

  it("rejects non-positive totals and empty eligible sets", () => {
    expect(() => proRataShares({ holders: [holder(1n)], totalLamports: 0n })).toThrow(
      /positive/,
    );
    expect(() => proRataShares({ holders: [], totalLamports: 100n })).toThrow(
      /no eligible holders/,
    );
    const only = Keypair.generate().publicKey;
    expect(() =>
      proRataShares({
        holders: [{ owner: only, amount: 5n }],
        totalLamports: 100n,
        excludeOwners: [only],
      }),
    ).toThrow(/no eligible holders/);
  });

  it("feeds buildClaimTree directly: Σ(claims) == allocated <= funded", () => {
    const holders = Array.from({ length: 7 }, (_, i) => holder(BigInt(i + 1) * 7n));
    const r = proRataShares({ holders, totalLamports: 123_457n });
    const tree = buildClaimTree(r.shares);
    expect(tree.totalLamports).toBe(r.allocatedLamports);
    expect(tree.totalLamports <= 123_457n).toBe(true);
    for (const s of r.shares) {
      expect(tree.proofFor(s.claimant).length).toBeGreaterThan(0);
    }
  });
});

describe("AUDIT F-11: unclaimable off-curve (PDA) owners", () => {
  // A program-derived address is OFF the ed25519 curve by construction — it
  // can never produce the signature new_claim requires.
  function pda(seed: string): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from(seed)],
      Keypair.generate().publicKey,
    )[0];
  }

  it("drops off-curve owners by default: their share would be unclaimable", () => {
    const pool = pda("pool"); // e.g. the AMM pool's base vault / bonding curve
    expect(PublicKey.isOnCurve(pool.toBytes())).toBe(false);
    const real = holder(100n);
    const r = proRataShares({
      holders: [{ owner: pool, amount: 9_000_000n }, real],
      totalLamports: 1_000n,
    });
    // the PDA got NOTHING; the real holder receives the full distribution, and
    // the denominator excludes the PDA's huge balance (no dilution).
    expect(r.shares).toHaveLength(1);
    expect(r.shares[0]!.claimant.equals(real.owner)).toBe(true);
    expect(r.shares[0]!.lamports).toBe(1_000n);
    expect(r.heldSupply).toBe(100n);
    expect(r.unclaimableHeld).toBe(9_000_000n);
  });

  it("refuses a distribution whose holders are ALL unclaimable PDAs", () => {
    expect(() =>
      proRataShares({
        holders: [{ owner: pda("only"), amount: 100n }],
        totalLamports: 1_000n,
      }),
    ).toThrow(/no eligible holders/);
  });

  it("can be disabled for callers that handle exclusion themselves", () => {
    const r = proRataShares({
      holders: [{ owner: pda("p2"), amount: 100n }, holder(100n)],
      totalLamports: 1_000n,
      dropUnclaimableOwners: false,
    });
    expect(r.shares).toHaveLength(2);
    expect(r.unclaimableHeld).toBe(0n);
  });
});

describe("proRataShares exclusion semantics", () => {
  it("treats excludeOwners as owners, not token accounts", () => {
    const excluded = Keypair.generate().publicKey;
    const kept = holder(100n);
    const r = proRataShares({
      holders: [
        { owner: excluded, amount: 50n },
        { owner: excluded, amount: 50n },
        kept,
      ],
      totalLamports: 1_000n,
      excludeOwners: [new PublicKey(excluded.toBytes())], // value equality
    });
    expect(r.shares).toHaveLength(1);
    expect(r.heldSupply).toBe(100n);
  });
});
