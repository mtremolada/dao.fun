/**
 * NativeCurveRail — launches a coin on OUR bonding curve instead of pump.fun,
 * behind the same `LaunchRail` seam the DAO ceremony already uses. Selecting
 * this rail is all that the "launch as DAO" toggle changes: the Squads vault
 * PDA is passed as the coin's `creator` (an argument, never a signer —
 * INV-CREATOR-ARG), so the DAO owns the curve's creator-fee stream without
 * anyone holding a key for it.
 */
import {
  PublicKey,
  TransactionInstruction,
  type Keypair,
} from "@solana/web3.js";
import type { LaunchParams, LaunchRail } from "../types";
import {
  buyQuote,
  initialState,
  tokensForSolInput,
  type CurveParams,
  type CurveState,
} from "../curve-math";
import { LAUNCHPAD_PROGRAM_ID, type Cluster } from "../launchpad/constants";
import { creatorVaultPda } from "../launchpad/pdas";
import {
  buildBuyIx,
  buildCollectCreatorFeeIx,
  buildCreateCoinIx,
} from "../launchpad/instructions";

export interface NativeCurveRailOpts {
  cluster: Cluster;
  /** The live curve parameters, for sizing an optional dev-buy. */
  params: CurveParams;
  /** The protocol fee recipient (config.fee_recipient), for a dev-buy's fee. */
  feeRecipient: PublicKey;
  programId?: PublicKey;
}

export class NativeCurveRail implements LaunchRail {
  private readonly programId: PublicKey;

  constructor(private readonly opts: NativeCurveRailOpts) {
    this.programId = opts.programId ?? LAUNCHPAD_PROGRAM_ID;
  }

  async buildCreateTokenIxs(
    p: LaunchParams,
    creator: PublicKey,
    mint: Keypair,
  ): Promise<TransactionInstruction[]> {
    if (!p.launcher) {
      throw new Error("NativeCurveRail requires LaunchParams.launcher (the create_coin payer)");
    }
    const ixs: TransactionInstruction[] = [
      buildCreateCoinIx({
        payer: p.launcher,
        mint: mint.publicKey,
        creator,
        name: p.metadata.name,
        symbol: p.metadata.symbol,
        uri: p.metadata.uri,
        programId: this.programId,
      }),
    ];

    // Optional atomic dev-buy: the creator's own first buy, bundled into the
    // launch so nobody can snipe the opening tick ahead of them. Sized to the
    // budget through the same curve math the on-chain program prices against.
    if (p.devBuyLamports && p.devBuyLamports > 0n) {
      const state: CurveState = initialState(this.opts.params);
      const tokenAmount = tokensForSolInput(state, p.devBuyLamports);
      if (tokenAmount > 0n) {
        // Pay up to the whole budget; the quote's real cost is at or below it.
        const cost = buyQuote(state, tokenAmount).totalCost;
        ixs.push(
          buildBuyIx({
            user: p.launcher,
            mint: mint.publicKey,
            creator,
            feeRecipient: this.opts.feeRecipient,
            tokenAmount,
            maxSolCost: cost,
            programId: this.programId,
          }),
        );
      }
    }
    return ixs;
  }

  async buildCollectFeesIxs(creator: PublicKey): Promise<TransactionInstruction[]> {
    // The native collect is per-curve (it authorizes against a bonding curve
    // whose creator matches), so a mint is required. The keeper's graduation
    // module calls buildCollectCreatorFeeIx directly with the mint it holds;
    // this seam exists for interface parity and needs an explicit mint.
    void creator;
    throw new Error(
      "NativeCurveRail.buildCollectFeesIxs needs a mint; use buildCollectCreatorFeeIx(creator, mint)",
    );
  }

  deriveCreatorVault(creator: PublicKey): PublicKey {
    return creatorVaultPda(creator, this.programId);
  }

  /** Per-curve creator-fee sweep, for the keeper. */
  buildCollect(creator: PublicKey, mint: PublicKey, payer: PublicKey): TransactionInstruction {
    return buildCollectCreatorFeeIx({ payer, creator, mint, programId: this.programId });
  }
}
