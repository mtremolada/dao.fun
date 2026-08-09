import { PublicKey } from "@solana/web3.js";

// Program IDs per spec Section 1. Pump programs are deployed at the same
// address on devnet and mainnet.
export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);
export const PUMP_FEES_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
export const SPL_GOVERNANCE_PROGRAM_ID = new PublicKey(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
);
export const VSR_PROGRAM_ID = new PublicKey(
  "vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ",
);
export const SQUADS_V4_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);

/** proposal-gate (ours) — Stage 3 guarded front door (gate v2, D-042). */
export const PROPOSAL_GATE_PROGRAM_ID = new PublicKey(
  "3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg",
);
// Jito merkle distributor (JTO airdrop deployment, Dec 2023). Resolved and
// verified on mainnet (D-024): executable, upgrade authority REMOVED
// (immutable), publishes its anchor IDL on chain (merkle_distributor 0.0.1,
// vendored at src/idl/merkle-distributor.json). The repo's declare_id
// (m1uq...) was never deployed to mainnet — this is the live one.
export const MERKLE_DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  "mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv",
);

// ---------------------------------------------------------------------------
// Launchpad (SPEC-LAUNCHPAD.md) — graduation venue: Raydium CPMM (CP-Swap).
//
// Everything below is verified against the DEPLOYED binaries, not the public
// source repo (the D-031/D-032 lesson). See DECISIONS.md D-034 and
// research/launchpad/followup-cpmm-binary.md.
// ---------------------------------------------------------------------------

/** Raydium CPMM (CP-Swap). Distinct ids per cluster — unlike the pump stack. */
export const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey(
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
);
export const RAYDIUM_CPMM_PROGRAM_ID_DEVNET = new PublicKey(
  "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
);

/**
 * AmmConfig index 0 — the standard 0.25% trade-fee tier, `disable_create_pool`
 * false on both clusters (verified on chain 2026-08-08).
 *
 * NOTE the devnet trap: raydium-cpi-example's README still lists an older,
 * parallel devnet deployment (CPMDWBwJ… / 9zSzfkYy… / G11FKB…). Pools created
 * there do not appear in Raydium's devnet UI. Always use the DRaycpLY… set.
 */
export const RAYDIUM_CPMM_AMM_CONFIG = new PublicKey(
  "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
);
export const RAYDIUM_CPMM_AMM_CONFIG_DEVNET = new PublicKey(
  "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
);

/**
 * `create_pool_fee` receiver — a wSOL token account hardcoded in the program
 * (`create_pool_fee_reveiver::ID`, Raydium's typo). `initialize` transfers
 * lamports to it then calls sync_native, so it must be passed writable.
 */
export const RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER = new PublicKey(
  "DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8",
);
export const RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER_DEVNET = new PublicKey(
  "3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy",
);

/** CPMM vault + LP-mint authority PDA: ["vault_and_lp_mint_auth_seed"]. */
export const RAYDIUM_CPMM_AUTHORITY = new PublicKey(
  "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
);

/** Metaplex Token Metadata — same address on every cluster. */
export const MPL_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/**
 * Slot of the CPMM upgrade our verification was performed against
 * (2026-06-11T16:39:55Z, commit 78f254e "support associated mint"). Fixture
 * dumps must be taken at or after this slot, and the ops runbook monitors the
 * live ProgramData slot against it: an unnoticed upgrade is exactly how the
 * spl-governance fork burned us (D-031).
 */
export const RAYDIUM_CPMM_VERIFIED_SLOT = 425_801_539;
