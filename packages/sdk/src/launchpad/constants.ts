/**
 * Launchpad constants — seeds, discriminators, cluster-aware Raydium
 * addresses, and the migration cost pins (SPEC-LAUNCHPAD.md).
 *
 * Browser-safe: this module and everything under `launchpad/` imports only
 * @solana/web3.js, @solana/spl-token address helpers, and @noble/hashes, so
 * the frontend can bundle instruction building and event decoding without
 * dragging in a node runtime.
 */
import { sha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_AMM_CONFIG,
  RAYDIUM_CPMM_AMM_CONFIG_DEVNET,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER_DEVNET,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID_DEVNET,
} from "../constants";

export type Cluster = "mainnet" | "devnet";

/**
 * The program id. A scaffold until the first devnet deploy mints the real
 * one (D-039); every builder takes a `programId` override so the app can pass
 * `NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID` / the backend `LAUNCHPAD_PROGRAM_ID`
 * without recompiling the SDK.
 */
export const LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr",
);

export const CONFIG_SEED = Buffer.from("config");
export const CURVE_SEED = Buffer.from("bonding-curve");
export const SOL_VAULT_SEED = Buffer.from("sol-vault");
export const CREATOR_VAULT_SEED = Buffer.from("creator-vault");
export const MIGRATION_AUTHORITY_SEED = Buffer.from("migration-authority");
export const POOL_SEED = Buffer.from("cpmm-pool");

/** Raydium's own PDA seeds, used to re-derive the pool's child accounts. */
export const RAYDIUM_AUTH_SEED = Buffer.from("vault_and_lp_mint_auth_seed");
export const RAYDIUM_LP_MINT_SEED = Buffer.from("pool_lp_mint");
export const RAYDIUM_POOL_VAULT_SEED = Buffer.from("pool_vault");
export const RAYDIUM_OBSERVATION_SEED = Buffer.from("observation");

export { MPL_TOKEN_METADATA_PROGRAM_ID };

/** Anchor instruction discriminator: sha256("global:<name>")[..8]. */
export function ixDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8));
}

/** Anchor event discriminator: sha256("event:<Name>")[..8]. */
export function eventDiscriminator(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`event:${name}`)).subarray(0, 8));
}

/**
 * Anchor `emit_cpi!` prefixes each self-CPI's instruction data with this
 * fixed 8-byte tag (little-endian of 0x1d9acb512ea545e4), then the event
 * discriminator, then the borsh event. The indexer keys on it to find events
 * inside a transaction's inner instructions.
 */
export const EVENT_IX_TAG = Buffer.from([
  0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d,
]);

/**
 * The six accounts Raydium's `initialize` rent-funds (PoolState 637 B,
 * ObservationState 4075 B, lp_mint, two vaults, the creator LP ATA), summed
 * to the lamport — measured against the deployed binary (D-034). The
 * pool-creation FEE is read live from AmmConfig; only these rent sizes are
 * fixed by layout.
 */
export const CPMM_RENT_LAMPORTS = 42_156_720n;
/** The observed pool-creation fee; migration reads the live value on chain. */
export const CREATE_POOL_FEE_LAMPORTS = 150_000_000n;
export const MIGRATION_OVERHEAD_LAMPORTS = CPMM_RENT_LAMPORTS + CREATE_POOL_FEE_LAMPORTS;

export interface RaydiumCpmmAddresses {
  program: PublicKey;
  ammConfig: PublicKey;
  createPoolFeeReceiver: PublicKey;
  /** ["vault_and_lp_mint_auth_seed"] under the cluster's CPMM program. */
  authority: PublicKey;
}

/**
 * The Raydium address set for a cluster. The authority is DERIVED, not
 * hardcoded — it is a PDA of the cluster's own CPMM program, so devnet's
 * differs from mainnet's (the devnet trap that strands pools).
 */
export function raydiumCpmmAddresses(cluster: Cluster): RaydiumCpmmAddresses {
  const program =
    cluster === "devnet" ? RAYDIUM_CPMM_PROGRAM_ID_DEVNET : RAYDIUM_CPMM_PROGRAM_ID;
  const [authority] = PublicKey.findProgramAddressSync([RAYDIUM_AUTH_SEED], program);
  return {
    program,
    ammConfig:
      cluster === "devnet" ? RAYDIUM_CPMM_AMM_CONFIG_DEVNET : RAYDIUM_CPMM_AMM_CONFIG,
    createPoolFeeReceiver:
      cluster === "devnet"
        ? RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER_DEVNET
        : RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
    authority,
  };
}
