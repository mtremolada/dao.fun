/**
 * Fixed action menu — spec 6.8. Safe preset builders whose output goes
 * through the ExecutionAdapter into proposals. Every builder validates its
 * bounds at build time AND constructs instructions that touch no accounts
 * outside the declared set; on-chain enforcement of the menu arrives with
 * the Stage 3 proposal-gate.
 *
 * MVP ships `grant` and `burn`. The remaining actions are blocked on open
 * (verify) items (DECISIONS.md): buyback/provideLiquidity on PumpSwap pool
 * ixs, distribute on the merkle distributor program ID, setParam on the
 * whitelisted-param registry.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

/** Default rent-exempt floor for a 0-data account; callers may refresh it. */
export const DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n;

export interface GrantParams {
  vault: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  rentFloorLamports?: bigint;
}

export function buildGrantIxs(p: GrantParams): TransactionInstruction[] {
  if (p.lamports <= 0n) {
    throw new Error("grant: lamports must be positive");
  }
  if (p.lamports > p.vaultBalanceLamports) {
    throw new Error(
      `grant: ${p.lamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  if (p.vaultBalanceLamports - p.lamports < floor) {
    throw new Error(
      `grant: would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }
  return [
    SystemProgram.transfer({
      fromPubkey: p.vault,
      toPubkey: p.recipient,
      lamports: p.lamports,
    }),
  ];
}

export interface BurnParams {
  vault: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Treasury token balance at build time. */
  vaultTokenBalance: bigint;
  tokenProgram: PublicKey;
}

/** Burns TREASURY-held tokens only: the source is the vault's own ATA. */
export function buildBurnIxs(p: BurnParams): TransactionInstruction[] {
  if (p.amount <= 0n) {
    throw new Error("burn: amount must be positive");
  }
  if (p.amount > p.vaultTokenBalance) {
    throw new Error(
      `burn: ${p.amount} exceeds treasury balance ${p.vaultTokenBalance}`,
    );
  }
  const vaultAta = getAssociatedTokenAddressSync(
    p.mint,
    p.vault,
    true,
    p.tokenProgram,
  );
  return [
    createBurnInstruction(vaultAta, p.mint, p.vault, p.amount, [], p.tokenProgram),
  ];
}
