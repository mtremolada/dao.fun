/**
 * Service wiring for the keeper core: real KeeperDeps from a Connection and
 * the PumpFunRail. Thin by design — all decision logic lives in keeper.ts
 * where it is unit-tested; this layer is exercised by the integration suite.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { PumpFunRail, derivePumpCreatorVault } from "@daofun/sdk";
import type { KeeperDeps } from "./keeper";

export interface KeeperServiceConfig {
  connection: Connection;
  keeperKeypair: Keypair;
  maxAttempts?: number;
  backoffMs?: number;
  computeUnitLimit?: number;
  priorityMicroLamports?: number;
}

export function makeKeeperDeps(cfg: KeeperServiceConfig): KeeperDeps {
  const { connection, keeperKeypair } = cfg;
  const rail = new PumpFunRail(connection);
  let rentFloor: bigint | undefined;

  async function rentMin(): Promise<bigint> {
    rentFloor ??= BigInt(await connection.getMinimumBalanceForRentExemption(0));
    return rentFloor;
  }

  return {
    keeper: keeperKeypair.publicKey,

    // Curve venue: lamports in the pump creator-fee vault above the rent
    // floor (D-009: the floor is not spendable). AMM venue accrual is added
    // when the first graduated token exists to test against (open item).
    async getAccruedFees(vault: PublicKey): Promise<bigint> {
      const feeVault = derivePumpCreatorVault(vault);
      const balance = BigInt(await connection.getBalance(feeVault));
      const floor = await rentMin();
      return balance > floor ? balance - floor : 0n;
    },

    async getVaultBalance(vault: PublicKey): Promise<bigint> {
      return BigInt(await connection.getBalance(vault));
    },

    buildCollectIxs(vault: PublicKey, feePayer: PublicKey) {
      return rail.buildCollectFeesIxs(vault, feePayer);
    },

    async sendAndConfirm(ixs: TransactionInstruction[]): Promise<string> {
      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: cfg.computeUnitLimit ?? 400_000,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: cfg.priorityMicroLamports ?? 50_000,
        }),
        ...ixs,
      );
      tx.feePayer = keeperKeypair.publicKey;
      return sendAndConfirmTransaction(connection, tx, [keeperKeypair], {
        commitment: "confirmed",
      });
    },

    maxAttempts: cfg.maxAttempts ?? 3,
    backoffMs: cfg.backoffMs ?? 2000,
  };
}
