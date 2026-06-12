/**
 * Governance — spec 6.3. Builds the full createDao instruction sequence:
 *
 *   [council mode] council mint: create, init, mint 1/member, null authority
 *   -> createRealm (name = realmNameForMint, authority = payer)
 *   -> VSR createRegistrar + configureVotingMint (baseline weight 0)
 *   -> createGovernance (resolved GovernanceParams)
 *   -> createNativeTreasury (must equal the advance-derived prediction)
 *   -> setRealmAuthority -> governance   (no platform backdoor)
 *
 * Mode is structural: the council mint only exists in council mode; veto
 * thresholds are Disabled otherwise (spec 12.2).
 */
import BN from "bn.js";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  GovernanceConfig,
  GoverningTokenConfigAccountArgs,
  GoverningTokenType,
  MintMaxVoteWeightSource,
  SetRealmAuthorityAction,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  getTokenOwnerRecordAddress,
  withCreateGovernance,
  withCreateNativeTreasury,
  withCreateRealm,
  withSetRealmAuthority,
} from "@solana/spl-governance";
import type { GovernanceMode, GovernanceParams } from "./types";
import {
  GATE_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "./constants";
import { deriveVsrRegistrar, realmNameForMint } from "./pda";
import {
  buildDepositCouncilIx,
  buildGateInitializeIx,
  deriveGate,
  gateSeatCouncilTokens,
  guardedVetoPercent,
} from "./gate";
import {
  VSR_SCALED_FACTOR_BASE,
  buildConfigureVotingMintIx,
  buildCreateRegistrarIx,
} from "./vsr";

// Re-exported so callers construct config values with THIS package's class
// identity — borsh schemas are keyed by class, so a structurally identical
// object from another spl-governance copy fails to serialize.
export { MintMaxVoteWeightSource };

const PROGRAM_VERSION = 3;
/** Voting duration. Not in the spec's tier table; see DECISIONS.md D-012. */
export const DEFAULT_BASE_VOTING_TIME_SECONDS = 3 * 86400;

export interface CouncilSetup {
  /** Fresh mint pubkey; its keypair must co-sign the ceremony tx. */
  mint: PublicKey;
  members: PublicKey[];
  vetoThresholdPercent: number;
  /** Rent-exempt lamports for MINT_SIZE (caller fetches; keeps builder offline). */
  mintRentLamports: bigint;
}

export interface CreateDaoParams {
  mint: PublicKey; // community mint (the launched token)
  payer: PublicKey; // launcher; transient realm authority during the ceremony
  mode: GovernanceMode;
  params: GovernanceParams;
  council?: CouncilSetup;
  baseVotingTimeSeconds?: number;
  /**
   * Realm max community vote weight source. Default FULL_SUPPLY_FRACTION
   * (production). Smoke/e2e runs may use Absolute so a small holder can
   * meet quorum without buying a supply fraction (see DECISIONS.md D-014).
   */
  communityMaxVoteWeightSource?: MintMaxVoteWeightSource;
  /**
   * VSR baseline weight for unlocked deposits. Default 0n — spec 6.3:
   * weight comes only from lockups. Non-zero is a TEST-ONLY deviation for
   * environments without clock control (see DECISIONS.md D-014).
   */
  baselineVoteWeightScaledFactor?: bigint;
  /**
   * Community voter-weight addin. Default: the VSR program. Pass null to
   * build a realm with NO addin and no VSR instructions — the fallback for
   * Token-2022 community mints, which the deployed VSR rejects (D-013).
   */
  communityVoterWeightAddin?: PublicKey | null;
  /**
   * Guarded mode only: the gate's program whitelist (max 16). Defaults to
   * the custody-chain minimum [System, Squads, proposal-gate]. The
   * governance program must NOT be listed — the gate hard-refuses it
   * while guarded anyway (D-033 config immutability).
   */
  guardedWhitelist?: PublicKey[];
}

export interface CreateDaoResult {
  /** All instructions in execution order (== groups flattened). */
  ixs: TransactionInstruction[];
  /**
   * The same instructions grouped at tx-size-safe boundaries, in EXECUTION
   * order: council FIRST (createRealm registers the council mint, so the
   * mint must already exist on chain — found by the GATE 1 bankrun leg),
   * then realmSetup (realm + VSR), then governanceSetup (governance +
   * native treasury + authority transfer). council is empty outside
   * council mode.
   */
  groups: {
    council: TransactionInstruction[];
    realmSetup: TransactionInstruction[];
    governanceSetup: TransactionInstruction[];
    /** Guarded only: gate initialize + council-seat deposit. Empty otherwise. */
    gateSetup: TransactionInstruction[];
  };
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
  registrar: PublicKey;
  config: GovernanceConfig;
  /** Guarded only: the gate PDA that holds realm authority + creation seat. */
  gate: PublicKey | null;
}

/** u64::MAX — the deployed fork treats it as an unreachable weight (the
 * spike proved a 100%-of-supply deposit cannot cross it, D-033). */
const DISABLED_WEIGHT = new BN("18446744073709551615");

export async function buildCreateDaoIxs(
  p: CreateDaoParams,
): Promise<CreateDaoResult> {
  // Guarded (spec 12.2): veto REQUIRED — a human council must exist.
  const councilModes: GovernanceMode[] = ["council", "guarded"];
  const hasCouncil = councilModes.includes(p.mode);
  if (hasCouncil && (!p.council || p.council.members.length === 0)) {
    throw new Error(`${p.mode} mode requires council.members and council.mint`);
  }
  if (!hasCouncil && p.council) {
    throw new Error("council config is only valid in council/guarded mode");
  }

  const realmSetup: TransactionInstruction[] = [];
  const council: TransactionInstruction[] = [];
  const governanceSetup: TransactionInstruction[] = [];
  const gateSetup: TransactionInstruction[] = [];
  const name = realmNameForMint(p.mint);
  const voterWeightAddin =
    p.communityVoterWeightAddin === undefined
      ? VSR_PROGRAM_ID
      : p.communityVoterWeightAddin;

  // 1. Realm — name derives the PDA chain; council mint registered up front.
  const realm = await withCreateRealm(
    realmSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    name,
    p.payer, // transient authority; transferred to governance at the end
    p.mint,
    p.payer,
    p.council?.mint,
    p.communityMaxVoteWeightSource ?? MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
    // Guarded: community governance creation is welded shut along with
    // proposal creation (D-033) — nothing realm-shaped exists outside
    // the gate.
    p.mode === "guarded"
      ? DISABLED_WEIGHT
      : new BN(p.params.proposalThresholdTokens.toString()),
    new GoverningTokenConfigAccountArgs({
      voterWeightAddin: voterWeightAddin ?? undefined,
      maxVoterWeightAddin: undefined,
      tokenType: GoverningTokenType.Liquid,
    }),
    p.council
      ? new GoverningTokenConfigAccountArgs({
          voterWeightAddin: undefined,
          maxVoterWeightAddin: undefined,
          tokenType: GoverningTokenType.Membership,
        })
      : undefined,
  );

  // 2. VSR while payer still holds realm authority (createRegistrar needs
  //    it). Skipped entirely when the realm is built without the addin.
  const registrar = deriveVsrRegistrar(realm, p.mint);
  if (voterWeightAddin !== null) {
    const created = buildCreateRegistrarIx({
      realm,
      communityMint: p.mint,
      realmAuthority: p.payer,
      payer: p.payer,
    });
    realmSetup.push(created.ix);
    realmSetup.push(
      buildConfigureVotingMintIx({
        registrar,
        realmAuthority: p.payer,
        mint: p.mint,
        idx: 0,
        digitShift: 0,
        // Spec 6.3: unlocked deposits vote with ZERO weight; weight comes
        // entirely from lockup, saturating at the tier's horizon.
        baselineVoteWeightScaledFactor: p.baselineVoteWeightScaledFactor ?? 0n,
        maxExtraLockupVoteWeightScaledFactor: VSR_SCALED_FACTOR_BASE,
        lockupSaturationSecs: BigInt(p.params.lockupSaturationSeconds),
      }),
    );
  }

  // 3. Council mint (council/guarded): 1 token per member, then no mint
  //    authority exists — membership is fixed at launch (structural veto set).
  //    Executes BEFORE createRealm, which registers (and validates) the mint.
  //    Guarded additionally seats the GATE with H+1 tokens: against
  //    minCouncil = H+1 the gate is the only record that can ever author
  //    proposals — all H humans pooled stay below the bar but keep the
  //    veto (D-033, verified on the deployed binary).
  const gate = deriveGate(realm);
  if (hasCouncil && p.council) {
    council.push(
      SystemProgram.createAccount({
        fromPubkey: p.payer,
        newAccountPubkey: p.council.mint,
        lamports: Number(p.council.mintRentLamports),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(p.council.mint, 0, p.payer, null),
    );
    for (const member of p.council.members) {
      const ata = getAssociatedTokenAddressSync(p.council.mint, member, true);
      council.push(
        createAssociatedTokenAccountIdempotentInstruction(
          p.payer,
          ata,
          member,
          p.council.mint,
        ),
        createMintToInstruction(p.council.mint, ata, p.payer, 1),
      );
    }
    if (p.mode === "guarded") {
      const gateAta = getAssociatedTokenAddressSync(p.council.mint, gate, true);
      council.push(
        createAssociatedTokenAccountIdempotentInstruction(
          p.payer,
          gateAta,
          gate,
          p.council.mint,
        ),
        createMintToInstruction(
          p.council.mint,
          gateAta,
          p.payer,
          gateSeatCouncilTokens(p.council.members.length),
        ),
      );
    }
    council.push(
      createSetAuthorityInstruction(
        p.council.mint,
        p.payer,
        AuthorityType.MintTokens,
        null,
      ),
    );
  }

  // 4. Governance config — resolved matrix params (spec Section 5).
  const disabled = new VoteThreshold({ type: VoteThresholdType.Disabled });
  const config = new GovernanceConfig({
    communityVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: p.params.quorumPercent,
    }),
    // Guarded: the community front door is welded shut — creation lives
    // exclusively with the gate's council seat (D-033).
    minCommunityTokensToCreateProposal:
      p.mode === "guarded"
        ? DISABLED_WEIGHT
        : new BN(p.params.proposalThresholdTokens.toString()),
    minInstructionHoldUpTime: p.params.holdUpSeconds,
    baseVotingTime: p.baseVotingTimeSeconds ?? DEFAULT_BASE_VOTING_TIME_SECONDS,
    communityVoteTipping: VoteTipping.Disabled, // full exit window, always
    minCouncilTokensToCreateProposal:
      p.mode === "guarded" && p.council
        ? new BN(gateSeatCouncilTokens(p.council.members.length))
        : new BN(1),
    councilVoteThreshold: disabled, // council cannot pass its own proposals
    councilVetoVoteThreshold:
      hasCouncil && p.council
        ? new VoteThreshold({
            type: VoteThresholdType.YesVotePercentage,
            // Guarded: the gate seat dilutes council supply to 2H+1, so
            // the nominal human threshold maps to an adjusted percent.
            value:
              p.mode === "guarded"
                ? guardedVetoPercent(
                    p.council.members.length,
                    p.council.vetoThresholdPercent,
                  )
                : p.council.vetoThresholdPercent,
          })
        : disabled, // structurally no veto outside council/guarded mode
    communityVetoVoteThreshold: disabled,
    councilVoteTipping: VoteTipping.Strict,
    votingCoolOffTime: 0,
    // D-015 (found live on mainnet): with 0, v3.1.4 demands a ~0.102 SOL
    // refundable security deposit per proposal. Anti-spam is already
    // provided by the token proposal threshold; exempt a sane window.
    depositExemptProposalCount: 10,
  });

  const payerTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    p.mint,
    p.payer,
  );
  const governance = await withCreateGovernance(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    p.mint, // governed seed == mint (advance-derivation rule)
    config,
    payerTor,
    p.payer,
    p.payer, // createAuthority == realm authority during the ceremony
  );

  const nativeTreasury = await withCreateNativeTreasury(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    governance,
    p.payer,
  );

  // 5. Hand the realm over — no platform key remains. Open modes: to its
  //    own governance (SetChecked). Guarded: to the GATE PDA (SetUnchecked
  //    — the gate is not a governance account; verified on the binary,
  //    D-033), which only ever releases it back to the governance after a
  //    voted ratchet.
  withSetRealmAuthority(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    p.payer,
    p.mode === "guarded" ? gate : governance,
    p.mode === "guarded"
      ? SetRealmAuthorityAction.SetUnchecked
      : SetRealmAuthorityAction.SetChecked,
  );

  // 6. Guarded: initialize the gate (immutable config) and seat it — the
  //    H+1 council tokens move into the gate's TokenOwnerRecord.
  if (p.mode === "guarded" && p.council) {
    gateSetup.push(
      buildGateInitializeIx({
        realm,
        governance,
        communityMint: p.mint,
        councilMint: p.council.mint,
        proposalThresholdTokens: p.params.proposalThresholdTokens,
        mode: 0,
        whitelist: p.guardedWhitelist ?? [
          SystemProgram.programId,
          SQUADS_V4_PROGRAM_ID,
          GATE_PROGRAM_ID,
        ],
        payer: p.payer,
      }),
      buildDepositCouncilIx({
        realm,
        councilMint: p.council.mint,
        payer: p.payer,
        amount: BigInt(gateSeatCouncilTokens(p.council.members.length)),
      }),
    );
  }

  return {
    ixs: [...council, ...realmSetup, ...governanceSetup, ...gateSetup],
    groups: { council, realmSetup, governanceSetup, gateSetup },
    realm,
    governance,
    nativeTreasury,
    registrar,
    config,
    gate: p.mode === "guarded" ? gate : null,
  };
}
