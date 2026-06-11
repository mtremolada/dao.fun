/**
 * Governance — spec 6.3. Builds the full createDao instruction sequence:
 *
 *   createRealm (name = realmNameForMint, authority = payer)
 *   -> VSR createRegistrar + configureVotingMint (baseline weight 0)
 *   -> [council mode] council mint: create, init, mint 1/member, null authority
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
import { SPL_GOVERNANCE_PROGRAM_ID, VSR_PROGRAM_ID } from "./constants";
import { realmNameForMint } from "./pda";
import {
  VSR_SCALED_FACTOR_BASE,
  buildConfigureVotingMintIx,
  buildCreateRegistrarIx,
} from "./vsr";

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
}

export interface CreateDaoResult {
  ixs: TransactionInstruction[];
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

  const ixs: TransactionInstruction[] = [];
  const name = realmNameForMint(p.mint);

  // 1. Realm — name derives the PDA chain; council mint registered up front.
  const realm = await withCreateRealm(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    name,
    p.payer, // transient authority; transferred to governance at the end
    p.mint,
    p.payer,
    p.council?.mint,
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
    new BN(p.params.proposalThresholdTokens.toString()),
    new GoverningTokenConfigAccountArgs({
      voterWeightAddin: VSR_PROGRAM_ID,
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

  // 2. VSR while payer still holds realm authority (createRegistrar needs it).
  const { ix: createRegistrarIx, registrar } = buildCreateRegistrarIx({
    realm,
    communityMint: p.mint,
    realmAuthority: p.payer,
    payer: p.payer,
  });
  ixs.push(createRegistrarIx);
  ixs.push(
    buildConfigureVotingMintIx({
      registrar,
      realmAuthority: p.payer,
      mint: p.mint,
      idx: 0,
      digitShift: 0,
      // Spec 6.3: unlocked deposits vote with ZERO weight; weight comes
      // entirely from lockup, saturating at the tier's horizon.
      baselineVoteWeightScaledFactor: 0n,
      maxExtraLockupVoteWeightScaledFactor: VSR_SCALED_FACTOR_BASE,
      lockupSaturationSecs: BigInt(p.params.lockupSaturationSeconds),
    }),
  );

  // 3. Council mint (council mode only): 1 token per member, then no mint
  //    authority exists — membership is fixed at launch (structural veto set).
  if (p.mode === "council" && p.council) {
    ixs.push(
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
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          p.payer,
          ata,
          member,
          p.council.mint,
        ),
        createMintToInstruction(p.council.mint, ata, p.payer, 1),
      );
    }
    ixs.push(
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
    depositExemptProposalCount: 0,
  });

  const payerTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    p.mint,
    p.payer,
  );
  const governance = await withCreateGovernance(
    ixs,
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
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    governance,
    p.payer,
  );

  // 5. Hand the realm to its own governance — no platform key remains.
  withSetRealmAuthority(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    p.payer,
    governance,
    SetRealmAuthorityAction.SetChecked,
  );

  return { ixs, realm, governance, nativeTreasury, registrar, config };
}
