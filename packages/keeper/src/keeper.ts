/**
 * Keeper core — spec 6.5.
 *
 * Permissionless fee sweeper: no authority, only pays tx fees (INV-2 is
 * enforced here as a refusal, independent of the rail's own guarantee).
 * Records the GROSS vault delta per sweep (INV-8 — no skim exists at this
 * layer). All lamport math is bigint (INV-6); a shrinking vault across a
 * sweep is a hard error, never silently absorbed.
 *
 * Dependencies are injected so the fund-path logic is testable offline; the
 * service wiring (Connection, PumpFunRail, scheduling, alerting) lives in
 * service.ts and is exercised by the integration suite.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { SweepResult } from "@daofun/sdk";

export interface KeeperDeps {
  /** The keeper's own pubkey — the only signer it will ever accept. */
  keeper: PublicKey;
  /** Collectable fees for a vault (above rent floors, all venues). */
  getAccruedFees(vault: PublicKey): Promise<bigint>;
  getVaultBalance(vault: PublicKey): Promise<bigint>;
  buildCollectIxs(
    vault: PublicKey,
    feePayer: PublicKey,
  ): Promise<TransactionInstruction[]>;
  sendAndConfirm(
    ixs: TransactionInstruction[],
    label: string,
  ): Promise<string>;
  maxAttempts: number;
  backoffMs: number;
}

export async function sweepVault(
  vault: PublicKey,
  deps: KeeperDeps,
): Promise<SweepResult | null> {
  const accrued = await deps.getAccruedFees(vault);
  if (accrued === 0n) return null; // idempotent: nothing to do, no tx

  const ixs = await deps.buildCollectIxs(vault, deps.keeper);
  for (const ix of ixs) {
    for (const meta of ix.keys) {
      if (meta.isSigner && !meta.pubkey.equals(deps.keeper)) {
        throw new Error(
          `INV-2: collect requires non-keeper signer ${meta.pubkey.toBase58()}; refusing`,
        );
      }
    }
  }

  const before = await deps.getVaultBalance(vault);

  let signature: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt++) {
    try {
      signature = await deps.sendAndConfirm(ixs, `sweep:${vault.toBase58()}`);
      break;
    } catch (e) {
      lastError = e;
      if (attempt < deps.maxAttempts) {
        await new Promise((r) => setTimeout(r, deps.backoffMs * 2 ** (attempt - 1)));
      }
    }
  }
  if (!signature) {
    throw new Error(
      `sweep failed after ${deps.maxAttempts} attempts: ${(lastError as Error)?.message}`,
    );
  }

  const after = await deps.getVaultBalance(vault);
  if (after < before) {
    throw new Error(
      `INV-6: vault decreased across a sweep (${before} -> ${after}); halting`,
    );
  }

  return {
    vault,
    grossLamports: after - before,
    signature,
    venue: "curve",
  };
}

/**
 * One scheduler tick: sweep every managed vault; one vault's failure never
 * blocks the others. Failures go to the alert hook (spec: alert on repeated
 * failure — counting/escalation is the service's concern).
 */
export async function runTick(
  vaults: PublicKey[],
  deps: KeeperDeps,
  onError: (vault: PublicKey, error: unknown) => void,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const vault of vaults) {
    try {
      const result = await sweepVault(vault, deps);
      if (result) results.push(result);
    } catch (e) {
      onError(vault, e);
    }
  }
  return results;
}
