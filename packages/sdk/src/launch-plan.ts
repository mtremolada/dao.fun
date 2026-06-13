/**
 * Self-service launch plan (spec 6.6, decentralized variant) — the keyless,
 * browser-buildable form of the launch sequence. NO server key is involved:
 * the USER's wallet is the launcher/fee-payer and signs every group, and the
 * throwaway mint/createKey/councilMint keypairs are generated and co-signed in
 * the browser. The advance-derivation rule (D-001) makes the whole
 * realm→governance→treasury chain knowable from the mint up front, so the
 * entire launch is built in one shot and submitted in order — no round-trips,
 * no intermediary.
 *
 * This mirrors `buildLaunchSteps` (the server-signed orchestrator) exactly,
 * including the AUDIT F-3 fee-last ordering and the F-12 council-before-realm
 * ordering, but emits unsigned instruction GROUPS + the ephemeral signers each
 * needs, instead of sending them itself.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { buildCreateTreasuryIx, deriveTreasuryPdas } from "./treasury";
import { buildCreateDaoIxs, type CouncilSetup } from "./governance";
import { deriveGovernanceChainFromMint } from "./pda";
import type { GovernanceMode, GovernanceParams, TreasuryRef } from "./types";

/**
 * Native-treasury prefund: its rent floor + one Squads execution's rent
 * headroom (D-016). Paid by the launcher; recovered to the DAO as Squads
 * accounts close (rentCollector). bigint for INV-6 math.
 */
export const TREASURY_EXECUTION_PREFUND_LAMPORTS = 6_000_000n;

export interface LaunchTxGroup {
  /** Stable step name; also the idempotency key for a resumable client. */
  label: string;
  instructions: TransactionInstruction[];
  /**
   * Ephemeral keypairs (by pubkey) that MUST co-sign this group besides the
   * launcher wallet. The browser holds the matching keypairs and partial-signs.
   */
  extraSigners: PublicKey[];
}

export interface LaunchPlanRequest {
  /** The USER's wallet — fee payer + signer of EVERY group (no server key). */
  launcher: PublicKey;
  /** Browser-generated ephemeral mint keypair's pubkey (create_v2 signer). */
  mint: PublicKey;
  /** Browser-generated Squads createKey pubkey (multisigCreateV2 signer). */
  createKey: PublicKey;
  mode: GovernanceMode;
  params: GovernanceParams;
  /**
   * The create-token instructions, pre-built by the rail
   * (`PumpFunRail.buildCreateTokenIxs(params, vaultPda, mintKeypair)`); the
   * creator MUST be the Squads vault PDA (INV-1).
   */
  createTokenIxs: TransactionInstruction[];
  /** Squads program-config treasury (`fetchProgramConfigTreasury`). */
  programConfigTreasury: PublicKey;
  /** Operator fee recipient. The fee group is omitted when the fee is 0. */
  protocolTreasury?: PublicKey;
  launchFeeLamports?: bigint;
  prefundLamports?: bigint;
  baseVotingTimeSeconds?: number;
  /** Required iff mode == "council"; carries the ephemeral council mint pubkey. */
  council?: CouncilSetup;
}

export interface LaunchPlan {
  /** Submit in order, confirming between dependent groups. */
  groups: LaunchTxGroup[];
  mint: PublicKey;
  treasury: TreasuryRef;
}

export async function buildLaunchPlan(
  req: LaunchPlanRequest,
): Promise<LaunchPlan> {
  if (
    (req.mode === "council" || req.mode === "guarded") &&
    (!req.council || req.council.members.length === 0)
  ) {
    throw new Error(
      `${req.mode} mode requires council.members and council.mint`,
    );
  }
  if (req.createTokenIxs.length === 0) {
    throw new Error("buildLaunchPlan: createTokenIxs must be non-empty");
  }

  const { multisigPda, vaultPda } = deriveTreasuryPdas(req.createKey);
  const predicted = deriveGovernanceChainFromMint(req.mint);

  const { ix: treasuryIx } = buildCreateTreasuryIx({
    payer: req.launcher,
    predictedNativeTreasury: predicted.nativeTreasury,
    createKey: req.createKey,
    programConfigTreasury: req.programConfigTreasury,
  });

  const dao = await buildCreateDaoIxs({
    mint: req.mint,
    payer: req.launcher,
    mode: req.mode,
    params: req.params,
    ...(req.council ? { council: req.council } : {}),
    ...(req.baseVotingTimeSeconds !== undefined
      ? { baseVotingTimeSeconds: req.baseVotingTimeSeconds }
      : {}),
    // pump create_v2 mints are always Token-2022 (D-004) — drop the VSR addin
    // + retarget the token program so create-dao executes (AUDIT F-1).
    communityTokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  // Advance-derivation must hold: the vault was created with this exact native
  // treasury as its sole member BEFORE the realm existed (INV-7).
  if (!dao.nativeTreasury.equals(predicted.nativeTreasury)) {
    throw new Error(
      "advance-derivation mismatch: built native treasury != prediction",
    );
  }

  const prefund = req.prefundLamports ?? TREASURY_EXECUTION_PREFUND_LAMPORTS;
  const fee = req.launchFeeLamports ?? 0n;

  const groups: LaunchTxGroup[] = [
    {
      label: "create-treasury",
      instructions: [treasuryIx],
      extraSigners: [req.createKey],
    },
    {
      label: "create-token",
      instructions: req.createTokenIxs,
      extraSigners: [req.mint],
    },
  ];
  // F-12: council mint FIRST — createRealm registers (validates) it. Guarded
  // seats a council too (the gate's H+1 + the human members).
  if (
    (req.mode === "council" || req.mode === "guarded") &&
    req.council
  ) {
    groups.push({
      label: "create-dao:council",
      instructions: dao.groups.council,
      extraSigners: [req.council.mint],
    });
  }
  groups.push(
    {
      label: "create-dao:realm",
      instructions: dao.groups.realmSetup,
      extraSigners: [],
    },
    {
      label: "create-dao:governance",
      instructions: dao.groups.governanceSetup,
      extraSigners: [],
    },
  );
  // Guarded only: initialize the gate (it now holds realm authority) + seat
  // its council tokens. Runs after governance (the realm authority was just
  // handed to the gate PDA). Empty group otherwise — omitted.
  if (req.mode === "guarded" && dao.groups.gateSetup.length > 0) {
    groups.push({
      label: "create-dao:gate",
      instructions: dao.groups.gateSetup,
      extraSigners: [],
    });
  }
  groups.push({
    label: "prefund-treasury",
    instructions: [
      SystemProgram.transfer({
        fromPubkey: req.launcher,
        toPubkey: predicted.nativeTreasury,
        lamports: prefund,
      }),
    ],
    extraSigners: [],
  });
  // F-3: charge the fee LAST, after the DAO + treasury exist, so a failed
  // launch never debits the launcher for an ungovernable token.
  if (fee > 0n) {
    if (!req.protocolTreasury) {
      throw new Error("launchFeeLamports > 0 requires protocolTreasury");
    }
    groups.push({
      label: "collect-launch-fee",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: req.launcher,
          toPubkey: req.protocolTreasury,
          lamports: fee,
        }),
      ],
      extraSigners: [],
    });
  }

  return {
    groups,
    mint: req.mint,
    treasury: {
      multisigPda,
      vaultPda,
      realm: predicted.realm,
      governance: predicted.governance,
      nativeTreasury: predicted.nativeTreasury,
    },
  };
}

/** The subset of `keypairs` that must co-sign `group` (by pubkey match). */
export function extraSignersFor<T extends { publicKey: PublicKey }>(
  group: LaunchTxGroup,
  keypairs: T[],
): T[] {
  const need = new Set(group.extraSigners.map((k) => k.toBase58()));
  return keypairs.filter((k) => need.has(k.publicKey.toBase58()));
}
