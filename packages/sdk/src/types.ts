import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type {
  EnhancedListingContent,
  EnhancedListingTarget,
} from "./enhanced-listing";

// Spec Section 4. "guarded" ships at Stage 3 (proposal-gate program).
export type GovernanceMode = "council" | "cypherpunk" | "sovereign" | "guarded";
export type MarketCapTier = "micro" | "small" | "mid" | "large";

export interface LaunchParams {
  metadata: { name: string; symbol: string; uri: string };
  daoConfig: DaoConfig;
  devBuyLamports?: bigint;
  rail: "pumpfun" | "meteora-dbc";
  /**
   * The launching wallet. Amendment to the spec Section 4 shape (DECISIONS.md
   * D-005): pump `create_v2` requires a `user` signer, so rails need to know
   * the launcher to build the create instruction. Required by PumpFunRail.
   */
  launcher?: PublicKey;
}

export interface DaoConfig {
  mode: GovernanceMode;
  marketCapTier: MarketCapTier; // sets floors per spec Section 5
  councilMembers?: PublicKey[]; // required iff mode == "council"
  councilVetoThresholdPercent?: number; // iff council
  sovereignHoldUpSeconds?: number; // iff sovereign; >= 0; double-confirmed
  /** Opt-in DEX Screener Enhanced Token Info, paid via community reimbursement (D-036). */
  enhancedListing?: EnhancedListingConfig;
}

/**
 * Enhanced-listing config committed at launch (D-036). No funds move at launch;
 * a community member later pays DEX Screener and is reimbursed by a DAO vote,
 * capped at feeCapLamports (INV-12). `content` is hashed into contentCommitment
 * (computeContentCommitment) so only the committed assets can be submitted.
 */
export interface EnhancedListingConfig {
  enabled: boolean;
  target: EnhancedListingTarget; // "dex-screener"
  feeCapLamports: bigint; // reimbursement ceiling (INV-12)
  contentCommitment: string; // sha256 over `content`
  content: EnhancedListingContent;
}

export type EnhancedListingStatus =
  | "open" // committed at launch; no claim yet
  | "claim-pending-vote"
  | "approved-awaiting-funds" // voted; keeper executes once the vault is funded
  | "live"
  | "disabled";

export interface EnhancedListingReceipt {
  dexScreenerUrl: string; // the live Enhanced Token Info page
  paymentTxSig: string; // the doer's on-chain payment to DEX Screener
  doer: PublicKey; // the proven payer wallet that was reimbursed
  claimedLamports: bigint; // actual amount reimbursed (<= feeCapLamports)
  submittedAt: number; // unix seconds
}

export interface GovernanceParams {
  // resolved via the Section 5 mode x tier matrix
  lockupSaturationSeconds: number;
  quorumPercent: number; // of max voter weight (verify semantics)
  proposalThresholdTokens: bigint;
  holdUpSeconds: number;
  vetoEnabled: boolean; // structural: council mint exists or not
}

export interface TreasuryRef {
  multisigPda: PublicKey;
  vaultPda: PublicKey; // == pump creator (INV-1)
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey; // sole multisig member (INV-7)
}

export interface LaunchResult {
  mint: PublicKey;
  treasury: TreasuryRef;
  mode: GovernanceMode;
  txSignatures: string[];
  mintAuthorityNull: boolean; // must be true (INV-5)
  predictedPdasMatched: boolean; // must be true (advance rule)
  /** Present iff the launch opted into an enhanced listing (D-036). */
  enhancedListing?: { contentCommitment: string; status: EnhancedListingStatus };
}

export interface SweepResult {
  vault: PublicKey;
  grossLamports: bigint; // full amount; no skim (INV-8)
  signature: string;
  venue: "curve" | "amm";
}

export interface LaunchRail {
  buildCreateTokenIxs(
    p: LaunchParams,
    creator: PublicKey,
    mint: Keypair,
  ): Promise<TransactionInstruction[]>;
  buildCollectFeesIxs(creator: PublicKey): Promise<TransactionInstruction[]>;
  deriveCreatorVault(creator: PublicKey): PublicKey;
}
