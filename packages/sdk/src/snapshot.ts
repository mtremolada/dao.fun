/**
 * Holder-snapshot share math — spec 6.8 `distribute`: "backend snapshots
 * holders at slot (RPC/DAS), builds tree". This is the pure half: raw
 * holder balances -> the ClaimShare[] the merkle tree is built from. The
 * snapshot SOURCE (RPC getProgramAccounts / Helius DAS) lives in the
 * backend behind HolderSnapshotSource so this stays offline-testable.
 *
 * Allocation rule: pro-rata by held amount with floor division — all math
 * is bigint (INV-6), Σ shares <= totalLamports always, and the dust
 * remainder is simply never proposed out of the vault. Owners with
 * multiple token accounts aggregate to a single claim (ClaimStatus PDAs
 * are per-claimant); zero balances and zero-lamport shares drop out (the
 * distributor refuses empty claims).
 */
import { PublicKey } from "@solana/web3.js";
import type { ClaimShare } from "./merkle-distributor";

export interface HolderBalance {
  owner: PublicKey;
  /** Token base units held (one owner may appear once per token account). */
  amount: bigint;
}

export interface ProRataParams {
  holders: HolderBalance[];
  /** Lamports the DAO is distributing (the distributor funding amount). */
  totalLamports: bigint;
  /** Owners that never receive a share: the vault, pools, treasuries. */
  excludeOwners?: PublicKey[];
  /**
   * Drop owners that are OFF the ed25519 curve — program-owned PDAs (the
   * bonding curve, AMM pool vaults, the DAO's own Squads vault, the
   * distributor, …). The merkle distributor's `new_claim` requires the
   * claimant to SIGN, which a PDA can never do permissionlessly, so an
   * off-curve share is permanently UNCLAIMABLE: it would only dilute real
   * holders and lock SOL in the distributor until clawback. A holder snapshot
   * of a graduated token is mostly the pool's vault, so without this a
   * distribute is economically broken by default (AUDIT F-11). Strictly
   * correct to exclude for this distributor; default true.
   */
  dropUnclaimableOwners?: boolean;
}

export interface ProRataResult {
  /** Deterministic order (by claimant base58); positive lamports only. */
  shares: ClaimShare[];
  /** Σ shares — what the distributor must actually be funded with. */
  allocatedLamports: bigint;
  /** totalLamports - allocated: floor-division dust; stays in the vault. */
  dustLamports: bigint;
  /** Σ eligible holder amounts (the pro-rata denominator). */
  heldSupply: bigint;
  /**
   * Token amount held by owners dropped as unclaimable (off-curve PDAs). When
   * non-zero, real circulating holders were the only ones allocated to — and
   * the operator should sanity-check that no genuine claimant was a PDA.
   */
  unclaimableHeld: bigint;
}

export function proRataShares(p: ProRataParams): ProRataResult {
  if (p.totalLamports <= 0n) {
    throw new Error("proRataShares: totalLamports must be positive");
  }
  const excluded = new Set((p.excludeOwners ?? []).map((o) => o.toBase58()));

  // Aggregate per owner; drop excluded owners and zero balances.
  const byOwner = new Map<string, bigint>();
  for (const h of p.holders) {
    if (h.amount < 0n) {
      throw new Error("proRataShares: negative holder amount");
    }
    const key = h.owner.toBase58();
    if (h.amount === 0n || excluded.has(key)) continue;
    byOwner.set(key, (byOwner.get(key) ?? 0n) + h.amount);
  }

  // Drop owners that can never claim (off-curve PDAs); their share would be
  // unclaimable and would dilute real holders (AUDIT F-11). Default on.
  let unclaimableHeld = 0n;
  if (p.dropUnclaimableOwners ?? true) {
    for (const [key, amount] of [...byOwner]) {
      if (!PublicKey.isOnCurve(new PublicKey(key).toBytes())) {
        byOwner.delete(key);
        unclaimableHeld += amount;
      }
    }
  }

  if (byOwner.size === 0) {
    throw new Error("proRataShares: no eligible holders");
  }

  let heldSupply = 0n;
  for (const amount of byOwner.values()) heldSupply += amount;

  const shares: ClaimShare[] = [];
  let allocatedLamports = 0n;
  for (const owner of [...byOwner.keys()].sort()) {
    const lamports = (p.totalLamports * byOwner.get(owner)!) / heldSupply;
    if (lamports === 0n) continue; // dust holder — cannot claim zero
    shares.push({ claimant: new PublicKey(owner), lamports });
    allocatedLamports += lamports;
  }
  if (allocatedLamports > p.totalLamports) {
    throw new Error("proRataShares: over-allocation (unreachable; INV-6 guard)");
  }

  return {
    shares,
    allocatedLamports,
    dustLamports: p.totalLamports - allocatedLamports,
    heldSupply,
    unclaimableHeld,
  };
}
