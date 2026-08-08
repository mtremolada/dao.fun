/**
 * Graduation crank — the launchpad's keeper leg.
 *
 * A completed curve becomes migratable, and `migrate` is permissionless: the
 * keeper is nobody special, it just pays the fee so graduation happens without
 * waiting for a stranger to notice. Losing the race to that stranger is a
 * SUCCESS, not a failure (the curve migrated either way), so an "already
 * migrated" refusal is treated as done.
 *
 * Dependencies are injected; the fund-path decision is testable offline.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export interface GraduationCandidate {
  mint: PublicKey;
  complete: boolean;
  migrated: boolean;
}

export interface GraduationDeps {
  /** Re-read on-chain state just before sending — the cache can be stale. */
  refreshCandidate(mint: PublicKey): Promise<{ complete: boolean; migrated: boolean }>;
  buildMigrateIx(mint: PublicKey): TransactionInstruction;
  sendAndConfirm(ix: TransactionInstruction, label: string): Promise<string>;
  onResult?(mint: PublicKey, outcome: GraduationOutcome): void;
}

export type GraduationOutcome =
  | { status: "migrated"; signature: string }
  | { status: "already-migrated" } // a stranger (or a prior tick) won the race
  | { status: "not-ready" }
  | { status: "error"; error: string };

const ALREADY_DONE = /already migrated|already in use|AlreadyMigrated/i;

/** Crank one candidate, isolated from the others. */
export async function crankMigration(
  candidate: GraduationCandidate,
  deps: GraduationDeps,
): Promise<GraduationOutcome> {
  let outcome: GraduationOutcome;
  try {
    if (!candidate.complete || candidate.migrated) {
      outcome = { status: "not-ready" };
    } else {
      const fresh = await deps.refreshCandidate(candidate.mint);
      if (fresh.migrated) outcome = { status: "already-migrated" };
      else if (!fresh.complete) outcome = { status: "not-ready" };
      else {
        try {
          const signature = await deps.sendAndConfirm(
            deps.buildMigrateIx(candidate.mint),
            `migrate ${candidate.mint.toBase58()}`,
          );
          outcome = { status: "migrated", signature };
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          outcome = ALREADY_DONE.test(msg)
            ? { status: "already-migrated" }
            : { status: "error", error: msg };
        }
      }
    }
  } catch (e) {
    outcome = { status: "error", error: (e as Error).message ?? String(e) };
  }
  deps.onResult?.(candidate.mint, outcome);
  return outcome;
}

/** Crank a batch; one failure never stops the rest (per-item isolation). */
export async function crankMigrations(
  candidates: GraduationCandidate[],
  deps: GraduationDeps,
): Promise<GraduationOutcome[]> {
  const out: GraduationOutcome[] = [];
  for (const c of candidates) {
    // Serial on purpose: the fee payer is one wallet with one blockhash lane,
    // and graduations are rare — parallelism buys nothing but nonce contention.
    out.push(await crankMigration(c, deps));
  }
  return out;
}
