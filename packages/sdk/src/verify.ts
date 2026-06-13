/**
 * On-chain DAO verifier (decentralized trust). A launchpad is permissionless,
 * so anyone can publish a token whose "DAO" is a sham. This lets any BUYER
 * verify, from chain alone, BOTH that there is no platform/launcher backdoor in
 * the structure AND what the governance PARAMETERS are — because a structurally
 * perfect DAO with a 1% quorum and a 0s hold-up is still a rug waiting to
 * happen. `ok` is the structural integrity (no backdoor); `riskFlags` surfaces
 * dangerous-but-legal config the buyer must judge for themselves.
 *
 * Pure reads; runs in the browser. Use it behind a "Verify this DAO" button.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import {
  Governance,
  Realm,
  VoteThresholdType,
  VoteTipping,
  getGovernanceAccount,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import { deriveGovernanceChainFromMint } from "./pda";

export interface DaoVerification {
  /** Structural integrity: no platform/launcher backdoor. */
  ok: boolean;
  checks: Record<string, boolean>;
  /** Governance parameters, surfaced so the buyer can judge rug risk. */
  config: {
    quorumPercent: number | null;
    holdUpSeconds: number | null;
    voteTippingDisabled: boolean | null;
  } | null;
  /** Dangerous-but-LEGAL config the buyer must weigh (not part of `ok`). */
  riskFlags: string[];
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
  const riskFlags: string[] = [];
  const notes: string[] = [];
  let config: DaoVerification["config"] = null;

  // Mint + freeze authority null (INV-5). AUDIT-B: resolve the token program
  // from the mint's OWNER so a Token-2022 mint (every pump launch) is not a
  // false negative when the caller omits `tokenProgram`.
  try {
    let tokenProgram = opts.tokenProgram;
    if (!tokenProgram) {
      const info = await connection.getAccountInfo(mint);
      if (info) tokenProgram = info.owner;
    }
    const m = await getMint(connection, mint, "confirmed", tokenProgram);
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

  // Governance governs exactly this mint — and READ ITS CONFIG (AUDIT-A): the
  // parameters that decide whether the launcher can rug, surfaced + risk-flagged.
  try {
    const gov = await getGovernanceAccount(
      connection,
      chain.governance,
      Governance,
    );
    checks["governanceGovernsMint"] = gov.account.governedAccount.equals(mint);

    const c = gov.account.config;
    const quorumPercent =
      c.communityVoteThreshold.type === VoteThresholdType.YesVotePercentage
        ? (c.communityVoteThreshold.value ?? null)
        : null;
    const holdUpSeconds = c.minInstructionHoldUpTime;
    const voteTippingDisabled = c.communityVoteTipping === VoteTipping.Disabled;
    config = { quorumPercent, holdUpSeconds, voteTippingDisabled };

    // Dangerous-but-legal config (informational; the buyer judges).
    if (holdUpSeconds === 0) riskFlags.push("zero-hold-up");
    if (!voteTippingDisabled) riskFlags.push("vote-tipping-enabled");
    if (quorumPercent !== null && quorumPercent < 10) {
      riskFlags.push("very-low-quorum");
    }
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
    config,
    riskFlags,
    realm: chain.realm.toBase58(),
    governance: chain.governance.toBase58(),
    nativeTreasury: chain.nativeTreasury.toBase58(),
    notes,
  };
}

/**
 * Convenience for the dashboard, which knows the realm (not the mint): read the
 * realm's community mint, then verify. Resolves the token program too.
 */
export async function verifyDaoByRealm(
  connection: Connection,
  realm: PublicKey,
  opts: { multisigPda?: PublicKey } = {},
): Promise<DaoVerification> {
  const r = await getGovernanceAccount(connection, realm, Realm);
  return verifyDao(connection, r.account.communityMint, opts);
}
