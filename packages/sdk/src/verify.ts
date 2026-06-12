/**
 * On-chain DAO verifier (decentralized trust). A launchpad is permissionless,
 * so anyone can publish a token whose "DAO" is a sham (a multisig they control,
 * a live mint authority, a sub-floor config). The defense is not to prevent it
 * but to make any BUYER able to verify, from chain alone, that a token's
 * governance is the genuine advance-derived structure with no human backdoor:
 *
 *   - the realm/governance/native-treasury chain matches the advance derivation
 *     from the mint (so the addresses are not attacker-substituted);
 *   - the realm authority IS its own governance (no platform/launcher key, INV);
 *   - the governance governs exactly this mint;
 *   - the mint + freeze authorities are null (INV-5);
 *   - (given the vault's multisig) its SOLE member is the native treasury, with
 *     threshold 1 and no config authority (INV-7) — i.e. the only controller is
 *     the DAO itself.
 *
 * Pure reads; runs in the browser. Use it behind a "Verify this DAO" button.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import { Governance, Realm, getGovernanceAccount } from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import { deriveGovernanceChainFromMint } from "./pda";

export interface DaoVerification {
  ok: boolean;
  checks: Record<string, boolean>;
  /** The advance-derived chain, for display. */
  realm: string;
  governance: string;
  nativeTreasury: string;
  notes: string[];
}

export async function verifyDao(
  connection: Connection,
  mint: PublicKey,
  opts: { tokenProgram?: PublicKey; multisigPda?: PublicKey } = {},
): Promise<DaoVerification> {
  const chain = deriveGovernanceChainFromMint(mint);
  const checks: Record<string, boolean> = {};
  const notes: string[] = [];

  // Mint + freeze authority null (INV-5).
  try {
    const m = await getMint(connection, mint, "confirmed", opts.tokenProgram);
    checks["mintAuthorityNull"] = m.mintAuthority === null;
    checks["freezeAuthorityNull"] = m.freezeAuthority === null;
  } catch (e) {
    checks["mintAuthorityNull"] = false;
    checks["freezeAuthorityNull"] = false;
    notes.push(`mint read failed: ${(e as Error).message}`);
  }

  // Realm exists and its authority is its OWN governance (no platform key).
  try {
    const realm = await getGovernanceAccount(connection, chain.realm, Realm);
    checks["realmExists"] = true;
    checks["realmAuthorityIsGovernance"] =
      realm.account.authority?.equals(chain.governance) ?? false;
    checks["communityMintMatches"] = realm.account.communityMint.equals(mint);
  } catch {
    checks["realmExists"] = false;
    checks["realmAuthorityIsGovernance"] = false;
    checks["communityMintMatches"] = false;
  }

  // Governance governs exactly this mint.
  try {
    const gov = await getGovernanceAccount(
      connection,
      chain.governance,
      Governance,
    );
    checks["governanceGovernsMint"] = gov.account.governedAccount.equals(mint);
  } catch {
    checks["governanceGovernsMint"] = false;
  }

  // INV-7: the Squads multisig's sole controller is the native treasury.
  if (opts.multisigPda) {
    try {
      const ms = await multisig.accounts.Multisig.fromAccountAddress(
        connection,
        opts.multisigPda,
      );
      checks["multisigSingleMember"] = ms.members.length === 1;
      checks["multisigMemberIsNativeTreasury"] =
        ms.members[0]?.key.equals(chain.nativeTreasury) ?? false;
      checks["multisigThresholdOne"] = Number(ms.threshold) === 1;
      checks["multisigNoConfigAuthority"] =
        ms.configAuthority.equals(PublicKey.default);
    } catch {
      checks["multisigSingleMember"] = false;
      checks["multisigMemberIsNativeTreasury"] = false;
      checks["multisigThresholdOne"] = false;
      checks["multisigNoConfigAuthority"] = false;
    }
  } else {
    notes.push(
      "pass the DAO's multisigPda to also verify custody (INV-7: sole member = native treasury)",
    );
  }

  return {
    ok: Object.values(checks).every(Boolean),
    checks,
    realm: chain.realm.toBase58(),
    governance: chain.governance.toBase58(),
    nativeTreasury: chain.nativeTreasury.toBase58(),
    notes,
  };
}
