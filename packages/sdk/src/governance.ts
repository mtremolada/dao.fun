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
  TOKEN_2022_PROGRAM_ID,
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
import { SPL_GOVERNANCE_PROGRAM_ID, VSR_PROGRAM_ID } from "./constants";
import { deriveVsrRegistrar, realmNameForMint } from "./pda";
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
   * Community voter-weight addin. Default: VSR for a classic-SPL community
   * mint, but automatically NULL for a Token-2022 community mint (the
   * deployed VSR rejects Token-2022 — D-013). Pass a value to override.
   */
  communityVoterWeightAddin?: PublicKey | null;
  /**
   * SPL token program that owns the COMMUNITY mint. Defaults to the classic
   * Token program; pass TOKEN_2022_PROGRAM_ID for a pump `create_v2` mint
   * (always Token-2022 — D-004). When Token-2022, the builder (D-013):
   *   - drops the VSR addin by default (VSR is classic-SPL only), and
   *   - retargets the realm/governance instructions' token-program account
   *     (the 0.3.28 `withCreateRealm` hardcodes the classic program for the
   *     holding accounts), and
   *   - mints the council membership token under Token-2022 too, because
   *     `withCreateRealm` passes ONE token-program account for BOTH the
   *     community and council holding accounts.
   * Without this, the produced instructions cannot execute for a Token-2022
   * community mint (AUDIT F-1).
   */
  communityTokenProgram?: PublicKey;
}

/**
 * Replace the classic-Token-program account with `to` in every instruction.
 * Used to retarget the realm/governance instructions to Token-2022 (D-013).
 * The community mint and all PDAs are distinct keys, so only the literal
 * program account is rewritten.
 */
function retargetTokenProgram(
  ixs: TransactionInstruction[],
  to: PublicKey,
): TransactionInstruction[] {
  return ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID) ? { ...k, pubkey: to } : k,
        ),
      }),
  );
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
  };
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
  registrar: PublicKey;
  config: GovernanceConfig;
}

export async function buildCreateDaoIxs(
  p: CreateDaoParams,
): Promise<CreateDaoResult> {
  if (p.mode === "guarded") {
    throw new Error("guarded mode ships at Stage 3 (proposal-gate program)");
  }
  if (p.mode === "council" && (!p.council || p.council.members.length === 0)) {
    throw new Error("council mode requires council.members and council.mint");
  }
  if (p.mode !== "council" && p.council) {
    throw new Error("council config is only valid in council mode");
  }

  const realmSetup: TransactionInstruction[] = [];
  const council: TransactionInstruction[] = [];
  const governanceSetup: TransactionInstruction[] = [];
  const name = realmNameForMint(p.mint);
  const communityTokenProgram = p.communityTokenProgram ?? TOKEN_PROGRAM_ID;
  const isToken2022 = communityTokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  // Token-2022 community mints cannot use the deployed VSR (D-013); default
  // them to a no-addin realm unless the caller overrides explicitly.
  const voterWeightAddin =
    p.communityVoterWeightAddin === undefined
      ? isToken2022
        ? null
        : VSR_PROGRAM_ID
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
    new BN(p.params.proposalThresholdTokens.toString()),
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

  // 3. Council mint (council mode only): 1 token per member, then no mint
  //    authority exists — membership is fixed at launch (structural veto set).
  //    Executes BEFORE createRealm, which registers (and validates) the mint.
  if (p.mode === "council" && p.council) {
    // The council mint shares the community mint's token program:
    // withCreateRealm passes ONE token-program account for both holding
    // accounts, so a Token-2022 community mint forces a Token-2022 council
    // mint (AUDIT F-1). MINT_SIZE (no extensions) is identical for both.
    council.push(
      SystemProgram.createAccount({
        fromPubkey: p.payer,
        newAccountPubkey: p.council.mint,
        lamports: Number(p.council.mintRentLamports),
        space: MINT_SIZE,
        programId: communityTokenProgram,
      }),
      createInitializeMint2Instruction(
        p.council.mint,
        0,
        p.payer,
        null,
        communityTokenProgram,
      ),
    );
    for (const member of p.council.members) {
      const ata = getAssociatedTokenAddressSync(
        p.council.mint,
        member,
        true,
        communityTokenProgram,
      );
      council.push(
        createAssociatedTokenAccountIdempotentInstruction(
          p.payer,
          ata,
          member,
          p.council.mint,
          communityTokenProgram,
        ),
        createMintToInstruction(
          p.council.mint,
          ata,
          p.payer,
          1,
          [],
          communityTokenProgram,
        ),
      );
    }
    council.push(
      createSetAuthorityInstruction(
        p.council.mint,
        p.payer,
        AuthorityType.MintTokens,
        null,
        [],
        communityTokenProgram,
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
    minCommunityTokensToCreateProposal: new BN(
      p.params.proposalThresholdTokens.toString(),
    ),
    minInstructionHoldUpTime: p.params.holdUpSeconds,
    baseVotingTime: p.baseVotingTimeSeconds ?? DEFAULT_BASE_VOTING_TIME_SECONDS,
    communityVoteTipping: VoteTipping.Disabled, // full exit window, always
    minCouncilTokensToCreateProposal: new BN(1),
    councilVoteThreshold: disabled, // council cannot pass its own proposals
    councilVetoVoteThreshold:
      p.mode === "council" && p.council
        ? new VoteThreshold({
            type: VoteThresholdType.YesVotePercentage,
            value: p.council.vetoThresholdPercent,
          })
        : disabled, // structurally no veto outside council mode
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

  // 5. Hand the realm to its own governance — no platform key remains.
  withSetRealmAuthority(
    governanceSetup,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    p.payer,
    governance,
    SetRealmAuthorityAction.SetChecked,
  );

  // Token-2022: retarget the classic token-program account the spl-governance
  // client hardcodes for the holding accounts (D-013). The council group
  // already targets `communityTokenProgram` directly, so it is left as built.
  const finalRealmSetup = isToken2022
    ? retargetTokenProgram(realmSetup, communityTokenProgram)
    : realmSetup;
  const finalGovernanceSetup = isToken2022
    ? retargetTokenProgram(governanceSetup, communityTokenProgram)
    : governanceSetup;

  return {
    ixs: [...council, ...finalRealmSetup, ...finalGovernanceSetup],
    groups: {
      council,
      realmSetup: finalRealmSetup,
      governanceSetup: finalGovernanceSetup,
    },
    realm,
    governance,
    nativeTreasury,
    registrar,
    config,
  };
}
