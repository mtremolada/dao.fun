/**
 * Post-graduation crank — the second and third legs of a graduation.
 *
 * `migrate` seeds the pool; on a cluster with Raydium's locker configured it
 * leaves the LP for `lock_graduated_liquidity`, and thereafter
 * `collect_graduated_fees` sweeps the pool's trading fees to the creator (a
 * DAO treasury, for DAO coins). Both are permissionless — the keeper is
 * nobody special, it just pays the signature so the DAO accrues without
 * anyone clicking, and losing the race to a stranger is a SUCCESS.
 *
 * The two legs are deliberately separate calls rather than one: the lock
 * happens exactly once per coin and the collect happens forever, so folding
 * them together would mean retrying a settled step on every tick.
 *
 * Dependencies are injected so the decision logic is testable offline.
 */
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export interface GraduatedCoin {
  mint: PublicKey;
  migrated: boolean;
  /** True once `lock_graduated_liquidity` has created the record. */
  locked: boolean;
}

export interface GraduatedFeeDeps {
  /** Re-read just before sending — a cached view can be stale by a slot. */
  refresh(mint: PublicKey): Promise<{ migrated: boolean; locked: boolean }>;
  buildLockIxs(mint: PublicKey): TransactionInstruction[];
  /** Includes the idempotent ATA creations the program requires to exist. */
  buildCollectIxs(mint: PublicKey): TransactionInstruction[];
  sendAndConfirm(ixs: TransactionInstruction[], label: string): Promise<string>;
  onResult?(mint: PublicKey, outcome: GraduatedFeeOutcome): void;
}

export type GraduatedFeeOutcome =
  | { status: "locked"; signature: string }
  | { status: "collected"; signature: string }
  | { status: "already-locked" } // a stranger won the race; still a success
  | { status: "nothing-to-collect" }
  | { status: "not-ready" }
  | { status: "error"; error: string };

const ALREADY_LOCKED = /already in use|GraduatedFees|0x0\b/i;
/** The program refuses a collect with nothing accrued; that is not an error. */
const NOTHING = /NothingToCollect|nothing to collect/i;
/** Locking is mainnet-only — devnet burns, and that is a settled state. */
const NO_LOCKER = /LockingDisabled|not configured on this cluster/i;

/**
 * Advance one coin by at most one step per tick: lock if it needs locking,
 * otherwise collect. One step keeps each transaction small and makes a stuck
 * coin obvious in the logs instead of hiding behind a retried batch.
 */
export async function crankGraduatedFees(
  coin: GraduatedCoin,
  deps: GraduatedFeeDeps,
): Promise<GraduatedFeeOutcome> {
  let outcome: GraduatedFeeOutcome;
  try {
    if (!coin.migrated) {
      outcome = { status: "not-ready" };
    } else {
      const fresh = await deps.refresh(coin.mint);
      if (!fresh.migrated) {
        outcome = { status: "not-ready" };
      } else if (!fresh.locked) {
        try {
          const signature = await deps.sendAndConfirm(
            deps.buildLockIxs(coin.mint),
            `lock ${coin.mint.toBase58()}`,
          );
          outcome = { status: "locked", signature };
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          if (ALREADY_LOCKED.test(msg)) outcome = { status: "already-locked" };
          else if (NO_LOCKER.test(msg)) outcome = { status: "not-ready" };
          else outcome = { status: "error", error: msg };
        }
      } else {
        try {
          const signature = await deps.sendAndConfirm(
            deps.buildCollectIxs(coin.mint),
            `collect ${coin.mint.toBase58()}`,
          );
          outcome = { status: "collected", signature };
        } catch (e) {
          const msg = (e as Error).message ?? String(e);
          outcome = NOTHING.test(msg)
            ? { status: "nothing-to-collect" }
            : { status: "error", error: msg };
        }
      }
    }
  } catch (e) {
    outcome = { status: "error", error: (e as Error).message ?? String(e) };
  }
  deps.onResult?.(coin.mint, outcome);
  return outcome;
}

/** Crank a batch; one failure never stops the rest (per-item isolation). */
export async function crankGraduatedFeesBatch(
  coins: GraduatedCoin[],
  deps: GraduatedFeeDeps,
): Promise<GraduatedFeeOutcome[]> {
  const out: GraduatedFeeOutcome[] = [];
  for (const coin of coins) {
    // Serial for the same reason migrations are: one fee payer, one
    // blockhash lane, and nonce contention buys nothing here.
    out.push(await crankGraduatedFees(coin, deps));
  }
  return out;
}
