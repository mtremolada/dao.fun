import { PublicKey } from "@solana/web3.js";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "./constants";

// All seed strings below are (verify) items per spec Sections 1 and 13.3.
// Verification status is recorded in DECISIONS.md; tests pin them against
// installed package source and (where possible) known on-chain accounts.

/** Pump bonding-curve creator vault: ["creator-vault", creator] (hyphen). */
export function derivePumpCreatorVault(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    PUMP_PROGRAM_ID,
  )[0];
}

/** PumpSwap AMM creator vault authority: ["creator_vault", coin_creator] (underscore). */
export function derivePumpAmmCreatorVaultAuthority(
  coinCreator: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("creator_vault"), coinCreator.toBuffer()],
    PUMP_AMM_PROGRAM_ID,
  )[0];
}

/** SPL Governance realm: ["governance", realm_name]. */
export function deriveRealm(realmName: string): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), Buffer.from(realmName)],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

/** SPL Governance account governance: ["account-governance", realm, governed_seed]. */
export function deriveGovernance(
  realm: PublicKey,
  governedSeed: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("account-governance"), realm.toBuffer(), governedSeed.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

/** SPL Governance native treasury: ["native-treasury", governance]. */
export function deriveNativeTreasury(governance: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("native-treasury"), governance.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

/** VSR registrar: ["registrar", realm, community_mint]. */
export function deriveVsrRegistrar(
  realm: PublicKey,
  communityMint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("registrar"), realm.toBuffer(), communityMint.toBuffer()],
    VSR_PROGRAM_ID,
  )[0];
}

/**
 * Realm name for a mint, per the advance-derivation rule — AMENDED (see
 * DECISIONS.md D-001): the spec's `realm_name := mint base58` is impossible
 * as written because a 43-44 char base58 string exceeds Solana's 32-byte
 * max PDA seed length. We use the first 32 base58 characters instead:
 * still deterministic, derivable before the mint account exists, and
 * collision-resistant (~187 bits of entropy).
 */
export const REALM_NAME_LEN = 32;
export function realmNameForMint(mint: PublicKey): string {
  return mint.toBase58().slice(0, REALM_NAME_LEN);
}

/**
 * Advance-derivation rule (spec Section 1, load-bearing): the whole chain
 * realm -> governance -> native treasury is computable from the mint pubkey
 * before any account exists, which lets the Squads vault be created with its
 * final sole member from the first instruction.
 */
export function deriveGovernanceChainFromMint(mint: PublicKey): {
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
} {
  const realm = deriveRealm(realmNameForMint(mint));
  const governance = deriveGovernance(realm, mint);
  const nativeTreasury = deriveNativeTreasury(governance);
  return { realm, governance, nativeTreasury };
}
