import type { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";

// Spec Section 4. "guarded" ships at Stage 3 (proposal-gate program).
export type GovernanceMode = "council" | "cypherpunk" | "sovereign" | "guarded";
export type MarketCapTier = "micro" | "small" | "mid" | "large";

export interface LaunchParams {
  metadata: { name: string; symbol: string; uri: string };
  daoConfig: DaoConfig;
  devBuyLamports?: bigint;
  rail: "pumpfun" | "meteora-dbc";
}

export interface DaoConfig {
  mode: GovernanceMode;
  marketCapTier: MarketCapTier; // sets floors per spec Section 5
  councilMembers?: PublicKey[]; // required iff mode == "council"
  councilVetoThresholdPercent?: number; // iff council
  sovereignHoldUpSeconds?: number; // iff sovereign; >= 0; double-confirmed
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
