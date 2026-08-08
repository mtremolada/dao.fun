/**
 * Launchpad PDA derivations. All parameterized by `programId` so the same
 * code serves the scaffold in tests and the real deployed id in production.
 */
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  CONFIG_SEED,
  CREATOR_VAULT_SEED,
  CURVE_SEED,
  LAUNCHPAD_PROGRAM_ID,
  MIGRATION_AUTHORITY_SEED,
  POOL_SEED,
  RAYDIUM_LP_MINT_SEED,
  RAYDIUM_OBSERVATION_SEED,
  RAYDIUM_POOL_VAULT_SEED,
  SOL_VAULT_SEED,
  type RaydiumCpmmAddresses,
} from "./constants";

const derive = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = (programId = LAUNCHPAD_PROGRAM_ID) =>
  derive([CONFIG_SEED], programId);

export const curvePda = (mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID) =>
  derive([CURVE_SEED, mint.toBuffer()], programId);

export const solVaultPda = (mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID) =>
  derive([SOL_VAULT_SEED, mint.toBuffer()], programId);

export const creatorVaultPda = (
  creator: PublicKey,
  programId = LAUNCHPAD_PROGRAM_ID,
) => derive([CREATOR_VAULT_SEED, creator.toBuffer()], programId);

export const migrationAuthorityPda = (
  mint: PublicKey,
  programId = LAUNCHPAD_PROGRAM_ID,
) => derive([MIGRATION_AUTHORITY_SEED, mint.toBuffer()], programId);

export const poolStatePda = (mint: PublicKey, programId = LAUNCHPAD_PROGRAM_ID) =>
  derive([POOL_SEED, mint.toBuffer()], programId);

export const metadataPda = (
  mint: PublicKey,
  metadataProgram: PublicKey,
) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), metadataProgram.toBuffer(), mint.toBuffer()],
    metadataProgram,
  )[0];

/**
 * Every Raydium account the graduation pool is built from, keyed off our
 * pool_state PDA and the byte-sorted (coin, wSOL) pair. Mirrors the migrate
 * instruction's own derivations exactly.
 */
export function cpmmPoolAccounts(
  mint: PublicKey,
  ray: RaydiumCpmmAddresses,
  programId = LAUNCHPAD_PROGRAM_ID,
) {
  const poolState = poolStatePda(mint, programId);
  const rp = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, ray.program)[0];
  const wsolIsToken0 = Buffer.compare(NATIVE_MINT.toBuffer(), mint.toBuffer()) < 0;
  const [mint0, mint1] = wsolIsToken0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  const lpMint = rp([RAYDIUM_LP_MINT_SEED, poolState.toBuffer()]);
  const migration = migrationAuthorityPda(mint, programId);
  return {
    poolState,
    wsolIsToken0,
    mint0,
    mint1,
    lpMint,
    vault0: rp([RAYDIUM_POOL_VAULT_SEED, poolState.toBuffer(), mint0.toBuffer()]),
    vault1: rp([RAYDIUM_POOL_VAULT_SEED, poolState.toBuffer(), mint1.toBuffer()]),
    observation: rp([RAYDIUM_OBSERVATION_SEED, poolState.toBuffer()]),
    migrationLp: getAssociatedTokenAddressSync(lpMint, migration, true),
  };
}
