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
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
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

// The offline PumpSdk carries pre-built anchor Program objects for the pump
// and pump_amm IDLs; they are typed private but are the supported way to
// encode instructions the sdk has no creator-agnostic wrapper for (its own
// transferCreatorFeesToPumpV2 hardcodes the fee-sharing-config PDA as
// coinCreator, which is wrong for a plain PDA creator like our vault).
type AnchorIxBuilder = {
  accountsPartial(accounts: Record<string, PublicKey>): {
    instruction(): Promise<TransactionInstruction>;
  };
};
type OfflinePumpPrograms = {
  offlinePumpProgram: {
    methods: { collectCreatorFeeV2(): AnchorIxBuilder };
  };
  offlinePumpAmmProgram: {
    methods: { transferCreatorFeesToPumpV2(): AnchorIxBuilder };
  };
};

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

  /**
   * Curve venue collect (collect_creator_fee_v2): zero signer accounts; the
   * accrued lamports above the rent floor (D-009) move to `creator`. Offline.
   */
  buildCurveCollectIx(creator: PublicKey): Promise<TransactionInstruction> {
    const programs = this.sdk as unknown as OfflinePumpPrograms;
    return programs.offlinePumpProgram.methods
      .collectCreatorFeeV2()
      .accountsPartial({
        creator,
        quoteMint: NATIVE_MINT,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
        creatorVault: derivePumpCreatorVault(creator),
      })
      .instruction();
  }

  /**
   * AMM venue consolidation (transfer_creator_fees_to_pump_v2, spec 6.5):
   * moves the WSOL accrued in the AMM creator-vault ATA into the CURVE
   * creator vault as native SOL, so one curve collect sweeps both venues
   * and the DAO never custodies WSOL. The only signer is `payer`. Offline.
   */
  buildConsolidateAmmFeesIx(
    creator: PublicKey,
    payer: PublicKey,
  ): Promise<TransactionInstruction> {
    const programs = this.sdk as unknown as OfflinePumpPrograms;
    return programs.offlinePumpAmmProgram.methods
      .transferCreatorFeesToPumpV2()
      .accountsPartial({
        payer,
        quoteMint: NATIVE_MINT,
        tokenProgram: TOKEN_PROGRAM_ID,
        coinCreator: creator,
      })
      .instruction();
  }

  async buildCollectFeesIxs(
    creator: PublicKey,
    feePayer?: PublicKey,
  ): Promise<TransactionInstruction[]> {
    // Both venues, native-SOL denominated: consolidate AMM WSOL into the
    // curve creator vault first (when any has accrued), then collect.
    const ammVaultAta = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      derivePumpAmmCreatorVaultAuthority(creator),
      true,
      TOKEN_PROGRAM_ID,
    );
    const [ammInfo] = await this.connection.getMultipleAccountsInfo([
      ammVaultAta,
    ]);
    const ammAccrued = ammInfo
      ? unpackAccount(ammVaultAta, ammInfo, TOKEN_PROGRAM_ID).amount
      : 0n;
    const ixs: TransactionInstruction[] = [];
    if (ammAccrued > 0n) {
      if (!feePayer) {
        throw new Error(
          "feePayer required: AMM consolidation needs a paying signer and the creator must never sign (INV-2)",
        );
      }
      ixs.push(await this.buildConsolidateAmmFeesIx(creator, feePayer));
    }
    ixs.push(await this.buildCurveCollectIx(creator));
    return ixs;
  }

  /**
   * Creator Fee Sharing configured at launch: {vault: 10000-bps, protocol:
   * bps}. GATE 0c DETERMINED (D-019): the deployed PumpFees program only
   * accepts the coin creator as payer/signer, so a PDA creator can NEVER
   * carry this within the launch ceremony — the gate stays closed and this
   * throws FeatureUnavailable. The same instructions DO work post-launch
   * through the governance custody chain (a 6.8 menu action, built at
   * first need).
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
