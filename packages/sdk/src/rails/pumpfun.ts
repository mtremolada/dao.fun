/**
 * PumpFunRail — spec 6.1.
 *
 * INV-1: `creator` passed to create_v2 is the Squads vault PDA; the IDL
 * carries it as an instruction arg, never a signer (verified, DECISIONS.md).
 * INV-2: collect_creator_fee_v2 has zero signer accounts; the only tx-level
 * signer is the fee-payer.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getPumpFeeProgram,
  type Shareholder,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import type { LaunchParams, LaunchRail } from "../types";
import {
  derivePumpAmmCreatorVaultAuthority,
  derivePumpCreatorVault,
} from "../pda";

/** Thrown when a feature is gated off (e.g. GATE 0c not passed). */
export class FeatureUnavailableError extends Error {
  constructor(feature: string) {
    super(`FeatureUnavailable: ${feature}`);
    this.name = "FeatureUnavailableError";
  }
}

export interface PumpFunRailOpts {
  /** GATE 0c outcome. Until the gate passes on devnet this stays false. */
  feeSharesEnabled?: boolean;
}

export interface FeeSharesParams {
  mint: PublicKey;
  vault: PublicKey; // DAO treasury vault (Squads vault PDA)
  protocolTreasury: PublicKey;
  protocolBps: number; // (0, 10000) exclusive
}

export class PumpFunRail implements LaunchRail {
  private readonly sdk = new PumpSdk();
  private readonly online: OnlinePumpSdk;

  constructor(
    private readonly connection: Connection,
    private readonly opts: PumpFunRailOpts = {},
  ) {
    this.online = new OnlinePumpSdk(connection);
  }

  deriveCreatorVault(creator: PublicKey): PublicKey {
    return derivePumpCreatorVault(creator);
  }

  deriveAmmCreatorVaultAuthority(creator: PublicKey): PublicKey {
    return derivePumpAmmCreatorVaultAuthority(creator);
  }

  async buildCreateTokenIxs(
    p: LaunchParams,
    creator: PublicKey,
    mint: Keypair,
  ): Promise<TransactionInstruction[]> {
    if (!p.launcher) {
      throw new Error("PumpFunRail requires LaunchParams.launcher (create_v2 user signer)");
    }
    const { name, symbol, uri } = p.metadata;

    if (p.devBuyLamports && p.devBuyLamports > 0n) {
      const global = await this.online.fetchGlobal();
      const solAmount = new BN(p.devBuyLamports.toString());
      return this.sdk.createV2AndBuyInstructions({
        global,
        mint: mint.publicKey,
        name,
        symbol,
        uri,
        creator,
        user: p.launcher,
        amount: getBuyTokenAmountFromSolAmount({
          global,
          feeConfig: null,
          mintSupply: null,
          bondingCurve: null,
          amount: solAmount,
          quoteMint: NATIVE_MINT,
        }),
        solAmount,
        mayhemMode: false,
      });
    }

    return [
      await this.sdk.createV2Instruction({
        mint: mint.publicKey,
        name,
        symbol,
        uri,
        creator,
        user: p.launcher,
        mayhemMode: false,
      }),
    ];
  }

  async buildCollectFeesIxs(
    creator: PublicKey,
    feePayer?: PublicKey,
  ): Promise<TransactionInstruction[]> {
    // Covers both venues: curve (collect_creator_fee_v2) and, post-graduation,
    // the PumpSwap AMM collect when the vault ATA exists.
    return this.online.collectCoinCreatorFeeV2Instructions(
      creator,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      feePayer,
    );
  }

  /**
   * Creator Fee Sharing configured at launch: {vault: 10000-bps, protocol:
   * bps}. Gated by GATE 0c (spec 6.1/7): until the gate proves a PDA creator
   * can carry a sharing config set within the launch ceremony and then be
   * admin-revoked, this throws FeatureUnavailable.
   */
  async buildFeeSharesAtLaunchIxs(
    params: FeeSharesParams,
  ): Promise<TransactionInstruction[]> {
    if (!this.opts.feeSharesEnabled) {
      throw new FeatureUnavailableError(
        "fee shares at launch (GATE 0c not passed)",
      );
    }
    const { mint, vault, protocolTreasury, protocolBps } = params;
    if (!Number.isInteger(protocolBps) || protocolBps <= 0 || protocolBps >= 10_000) {
      throw new Error(`protocolBps must be an integer in (0, 10000), got ${protocolBps}`);
    }
    const shareholders: Shareholder[] = [
      { address: vault, shareBps: 10_000 - protocolBps },
      { address: protocolTreasury, shareBps: protocolBps },
    ];
    return [
      await this.sdk.createFeeSharingConfig({ creator: vault, mint, pool: null }),
      await this.sdk.updateFeeShares({
        authority: vault,
        mint,
        currentShareholders: [vault],
        newShareholders: shareholders,
      }),
    ];
  }

  /** Decode the shareholder table out of fee-shares ixs (used by tests/UI). */
  async decodeFeeShares(
    ixs: TransactionInstruction[],
  ): Promise<Array<{ address: string; shareBps: number }>> {
    // anchor 0.30's InstructionCoder interface omits decode(); the concrete
    // Borsh coder has it at runtime.
    const coder = getPumpFeeProgram(this.connection).coder
      .instruction as unknown as {
      decode(data: Buffer): { name: string; data: unknown } | null;
    };
    for (const ix of ixs) {
      const decoded = coder.decode(ix.data);
      if (decoded?.name === "updateFeeShares") {
        const data = decoded.data as {
          shareholders: Array<{ address: PublicKey; shareBps: number }>;
        };
        return data.shareholders.map((s) => ({
          address: s.address.toBase58(),
          shareBps: s.shareBps,
        }));
      }
    }
    return [];
  }
}
