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
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import {
  PumpFunRail,
  derivePumpAmmCreatorVaultAuthority,
  derivePumpCreatorVault,
} from "@daofun/sdk";
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
    // floor (D-009: the floor is not spendable). AMM venue (post-graduation):
    // WSOL in the AMM creator-vault ATA, 1 lamport per unit — the collect
    // path consolidates it into the curve vault before sweeping (spec 6.5).
    async getAccruedFees(vault: PublicKey): Promise<bigint> {
      const feeVault = derivePumpCreatorVault(vault);
      const ammVaultAta = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        derivePumpAmmCreatorVaultAuthority(vault),
        true,
        TOKEN_PROGRAM_ID,
      );
      const [feeInfo, ammInfo] = await connection.getMultipleAccountsInfo([
        feeVault,
        ammVaultAta,
      ]);
      const floor = await rentMin();
      const curveLamports = feeInfo ? BigInt(feeInfo.lamports) : 0n;
      const curve = curveLamports > floor ? curveLamports - floor : 0n;
      const amm = ammInfo
        ? unpackAccount(ammVaultAta, ammInfo, TOKEN_PROGRAM_ID).amount
        : 0n;
      return curve + amm;
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
