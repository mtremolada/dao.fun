/**
 * Fixed action menu — spec 6.8. Safe preset builders whose output goes
 * through the ExecutionAdapter into proposals. Every builder validates its
 * bounds at build time AND constructs instructions that touch no accounts
 * outside the declared set; on-chain enforcement of the menu arrives with
 * the Stage 3 proposal-gate.
 *
 * MVP ships `grant`, `burn`, `buyback` (curve venue AND, post-graduation,
 * the token's own PumpSwap pool) and `provideLiquidity` (PumpSwap pool) —
 * the pool-ix verify item resolved against @pump-fun/pump-swap-sdk's
 * offline builder (D-021). Still blocked: distribute on the merkle
 * distributor program ID, setParam on the whitelisted-param registry.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import {
  PumpAmmSdk,
  buyQuoteInput,
  type LiquiditySolanaState,
  type SwapSolanaState,
} from "@pump-fun/pump-swap-sdk";
import BN from "bn.js";
import { PUMP_AMM_PROGRAM_ID } from "./constants";

/** Default rent-exempt floor for a 0-data account; callers may refresh it. */
export const DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n;

export interface GrantParams {
  vault: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  rentFloorLamports?: bigint;
}

export function buildGrantIxs(p: GrantParams): TransactionInstruction[] {
  if (p.lamports <= 0n) {
    throw new Error("grant: lamports must be positive");
  }
  if (p.lamports > p.vaultBalanceLamports) {
    throw new Error(
      `grant: ${p.lamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  if (p.vaultBalanceLamports - p.lamports < floor) {
    throw new Error(
      `grant: would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }
  return [
    SystemProgram.transfer({
      fromPubkey: p.vault,
      toPubkey: p.recipient,
      lamports: p.lamports,
    }),
  ];
}

export interface BurnParams {
  vault: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Treasury token balance at build time. */
  vaultTokenBalance: bigint;
  tokenProgram: PublicKey;
}

export interface BuybackParams {
  /** The DAO's Squads vault — the buying `user`; signs via the custody chain. */
  vault: PublicKey;
  /** The DAO's own token (v2 mints are Token-2022, D-004). */
  mint: PublicKey;
  /** SOL to spend on the buy (pump fees come on top — see headroom). */
  solLamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  /** Live pump state at build time (the chain reader / orchestrator supplies it). */
  global: Global;
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  bondingCurve: BondingCurve;
  /** Buy slippage percent (pump-sdk convention); default 5. */
  slippagePercent?: number;
  rentFloorLamports?: bigint;
}

// pump's buy fee (protocol + creator bps) is paid on top of solAmount;
// budget ~2% headroom plus the floor when validating spendability.
const BUYBACK_FEE_HEADROOM_BPS = 200n;

/**
 * Buyback on the token's OWN bonding curve (spec 6.8: buyback is pinned to
 * the token's curve/pool — no external routing). The vault is the buying
 * user; the ExecutionAdapter chain provides its signature. The vault's
 * token ATA must already exist — ATA creation is permissionless and MUST
 * happen outside the proposal to keep the execute insert under the D-019
 * size ceiling. Post-graduation (PumpSwap) buyback stays blocked on the
 * pool-ix verify item.
 */
export async function buildBuybackIxs(
  p: BuybackParams,
): Promise<TransactionInstruction[]> {
  if (p.solLamports <= 0n) {
    throw new Error("buyback: solLamports must be positive");
  }
  if (p.solLamports > p.vaultBalanceLamports) {
    throw new Error(
      `buyback: ${p.solLamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  const withFees =
    p.solLamports + (p.solLamports * BUYBACK_FEE_HEADROOM_BPS) / 10_000n;
  if (p.vaultBalanceLamports - withFees < floor) {
    throw new Error(
      `buyback: spend + fee headroom would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }

  const solAmount = new BN(p.solLamports.toString());
  const sdk = new PumpSdk();
  const ixs = await sdk.buyInstructions({
    global: p.global,
    bondingCurveAccountInfo: p.bondingCurveAccountInfo,
    bondingCurve: p.bondingCurve,
    // non-null: the vault ATA exists (pre-created permissionlessly), so the
    // sdk emits no ATA-create instruction inside the proposal.
    associatedUserAccountInfo: p.bondingCurveAccountInfo,
    mint: p.mint,
    user: p.vault,
    amount: getBuyTokenAmountFromSolAmount({
      global: p.global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: p.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    }),
    solAmount,
    slippage: p.slippagePercent ?? 5,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  return ixs;
}

/**
 * AMM-venue actions are STAGED (D-022): a PumpSwap buy carries ~26
 * accounts, so its Squads `vaultTransactionExecute` cannot fit a
 * governance InsertTransaction (the insert stores raw account metas — no
 * packing trick compresses them past the 1232-byte transaction limit).
 * Instead, one proposal carries two kinds of legs:
 *
 *   vaultIxs    — vault-signed, routed through the Squads custody chain
 *                 (buildProposeIxs `innerIxs`): stage the spend out of the
 *                 vault to the native treasury;
 *   treasuryIxs — signed by the governance native treasury (the multisig's
 *                 SOLE member — still a no-human-key PDA, INV-7 intact),
 *                 inserted directly (buildProposeIxs `directIxs`): act on
 *                 the AMM, then return the proceeds to the vault.
 *
 * Every leg is hash-pinned (INV-9) and hold-up-gated (INV-3); final
 * custody of tokens/LP returns to the Squads vault within the proposal.
 */
export interface AmmBuybackParams {
  /** The DAO's Squads vault — SOL source, coin creator, final token custody. */
  vault: PublicKey;
  /** The governance native treasury — the acting wallet; `swapState.user`. */
  nativeTreasury: PublicKey;
  /** The DAO's own token; must be the pool's base mint (spec 6.8 pinning). */
  mint: PublicKey;
  /** Quote (SOL) spent on the buy — PumpSwap fees come OUT of this amount. */
  solLamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  /**
   * Live PumpSwap state at build time (chain reader / orchestrator supplies
   * it). `user` MUST be the native treasury; its base + WSOL ATAs MUST
   * exist already (pre-created permissionlessly OUTSIDE the proposal —
   * D-019), as must the VAULT's base ATA the proceeds return to.
   */
  swapState: SwapSolanaState;
  /** Buy slippage percent (pump-swap-sdk convention); default 5. */
  slippagePercent?: number;
  rentFloorLamports?: bigint;
}

export interface AmmActionLegs {
  /** Vault-signed: pass as buildProposeIxs `innerIxs` (custody chain). */
  vaultIxs: TransactionInstruction[];
  /** Treasury-signed: pass as buildProposeIxs `directIxs`. */
  treasuryIxs: TransactionInstruction[];
}

// pump_amm extend_account (anchor discriminator). The sdk builds it with
// `user` read-only — on mainnet the fee payer is implicitly writable, but
// under governance CPI the stored proposal metas are the ONLY privilege
// source and the program charges `user` for the realloc rent. Promote it.
const EXTEND_ACCOUNT_DISCRIMINATOR = Buffer.from([
  234, 102, 194, 203, 150, 72, 62, 229,
]);

function promoteExtendAccountUser(
  ixs: TransactionInstruction[],
  user: PublicKey,
): TransactionInstruction[] {
  for (const ix of ixs) {
    if (
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) &&
      ix.data.subarray(0, 8).equals(EXTEND_ACCOUNT_DISCRIMINATOR)
    ) {
      for (const k of ix.keys) {
        if (k.pubkey.equals(user)) k.isWritable = true;
      }
    }
  }
  return ixs;
}

/**
 * Buyback on the token's OWN PumpSwap pool, post-graduation (spec 6.8: no
 * external routing). The vault stages maxQuote to the native treasury;
 * the treasury wraps, buys exact-base-out, unwraps, and sends the bought
 * tokens to the vault's ATA. The wrap remainder stays with the native
 * treasury (it funds future execution rent, D-016).
 */
export async function buildAmmBuybackIxs(
  p: AmmBuybackParams,
): Promise<AmmActionLegs> {
  if (p.solLamports <= 0n) {
    throw new Error("amm buyback: solLamports must be positive");
  }
  if (p.solLamports > p.vaultBalanceLamports) {
    throw new Error(
      `amm buyback: ${p.solLamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  if (!p.swapState.user.equals(p.nativeTreasury)) {
    throw new Error(
      "amm buyback: the swap state user must be the native treasury (the vault cannot ride a direct leg)",
    );
  }
  if (!p.swapState.pool.baseMint.equals(p.mint)) {
    throw new Error(
      "amm buyback: pinned to the DAO token's own pool — base mint mismatch",
    );
  }
  if (!p.swapState.userBaseAccountInfo || !p.swapState.userQuoteAccountInfo) {
    throw new Error(
      "amm buyback: treasury ATAs must be pre-created outside the proposal (D-019)",
    );
  }
  const slippage = p.slippagePercent ?? 5;
  const sdk = new PumpAmmSdk();
  const { base, maxQuote } = buyQuoteInput({
    quote: new BN(p.solLamports.toString()),
    slippage,
    baseReserve: p.swapState.poolBaseAmount,
    quoteReserve: p.swapState.poolQuoteAmount,
    globalConfig: p.swapState.globalConfig,
    baseMintAccount: p.swapState.baseMintAccount,
    baseMint: p.swapState.baseMint,
    coinCreator: p.swapState.pool.coinCreator,
    creator: p.swapState.pool.creator,
    feeConfig: p.swapState.feeConfig,
  });
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  const staged = BigInt(maxQuote.toString());
  if (p.vaultBalanceLamports - staged < floor) {
    throw new Error(
      `amm buyback: maxQuote would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }

  const buyIxs = promoteExtendAccountUser(
    await sdk.buyInstructions(p.swapState, base, maxQuote),
    p.nativeTreasury,
  );
  return {
    vaultIxs: [
      SystemProgram.transfer({
        fromPubkey: p.vault,
        toPubkey: p.nativeTreasury,
        lamports: staged,
      }),
    ],
    treasuryIxs: [
      ...buyIxs,
      // exact-base-out: the bought amount is `base` by construction —
      // return it to the vault's custody.
      createTransferInstruction(
        p.swapState.userBaseTokenAccount,
        getAssociatedTokenAddressSync(
          p.mint,
          p.vault,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        p.nativeTreasury,
        BigInt(base.toString()),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
  };
}

export interface ProvideLiquidityParams {
  vault: PublicKey;
  /** The governance native treasury — the acting wallet; state `user`. */
  nativeTreasury: PublicKey;
  /** The DAO's own token; must be the pool's base mint (spec 6.8 pinning). */
  mint: PublicKey;
  /** Quote (SOL) side of the deposit; the base side follows the pool ratio. */
  quoteLamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  /** Vault's base-token balance at build time — bounds maxBase. */
  vaultBaseTokenBalance: bigint;
  /**
   * Live PumpSwap state at build time. `user` MUST be the native treasury;
   * its base + WSOL + LP-token ATAs MUST exist already (D-019), as must
   * the VAULT's LP ATA the position returns to.
   */
  liquidityState: LiquiditySolanaState;
  /** Deposit slippage percent (pump-swap-sdk convention); default 5. */
  slippagePercent?: number;
  rentFloorLamports?: bigint;
}

/**
 * Deposit into the token's OWN PumpSwap pool (spec 6.8): the vault stages
 * SOL + its own tokens to the native treasury; the treasury deposits and
 * sends the LP tokens (exact-lp-out) back to the vault's LP ATA. Unused
 * base/quote dust (the slippage margins) stays with the native treasury.
 */
export async function buildProvideLiquidityIxs(
  p: ProvideLiquidityParams,
): Promise<AmmActionLegs> {
  if (p.quoteLamports <= 0n) {
    throw new Error("provideLiquidity: quoteLamports must be positive");
  }
  if (!p.liquidityState.user.equals(p.nativeTreasury)) {
    throw new Error(
      "provideLiquidity: the liquidity state user must be the native treasury (the vault cannot ride a direct leg)",
    );
  }
  if (!p.liquidityState.pool.baseMint.equals(p.mint)) {
    throw new Error(
      "provideLiquidity: pinned to the DAO token's own pool — base mint mismatch",
    );
  }
  if (
    !p.liquidityState.userBaseAccountInfo ||
    !p.liquidityState.userQuoteAccountInfo ||
    !p.liquidityState.userPoolAccountInfo
  ) {
    throw new Error(
      "provideLiquidity: treasury ATAs (incl. the LP token ATA) must be pre-created outside the proposal (D-019)",
    );
  }
  const slippage = p.slippagePercent ?? 5;
  const sdk = new PumpAmmSdk();
  const { lpToken, maxBase, maxQuote } = sdk.depositQuoteInput(
    p.liquidityState,
    new BN(p.quoteLamports.toString()),
    slippage,
  );
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  if (p.vaultBalanceLamports - BigInt(maxQuote.toString()) < floor) {
    throw new Error(
      `provideLiquidity: maxQuote would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }
  if (BigInt(maxBase.toString()) > p.vaultBaseTokenBalance) {
    throw new Error(
      `provideLiquidity: required base ${maxBase.toString()} exceeds treasury base balance ${p.vaultBaseTokenBalance}`,
    );
  }

  const depositIxs = promoteExtendAccountUser(
    await sdk.depositInstructionsInternal(
      p.liquidityState,
      lpToken,
      maxBase,
      maxQuote,
    ),
    p.nativeTreasury,
  );
  const vaultBaseAta = getAssociatedTokenAddressSync(
    p.mint,
    p.vault,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  return {
    vaultIxs: [
      SystemProgram.transfer({
        fromPubkey: p.vault,
        toPubkey: p.nativeTreasury,
        lamports: BigInt(maxQuote.toString()),
      }),
      createTransferInstruction(
        vaultBaseAta,
        p.liquidityState.userBaseTokenAccount,
        p.vault,
        BigInt(maxBase.toString()),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    treasuryIxs: [
      ...depositIxs,
      // exact-lp-out: the minted LP amount is `lpToken` by construction —
      // return the position to the vault's custody.
      createTransferInstruction(
        p.liquidityState.userPoolTokenAccount,
        getAssociatedTokenAddressSync(
          p.liquidityState.pool.lpMint,
          p.vault,
          true,
          TOKEN_2022_PROGRAM_ID,
        ),
        p.nativeTreasury,
        BigInt(lpToken.toString()),
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
  };
}

/** Burns TREASURY-held tokens only: the source is the vault's own ATA. */
export function buildBurnIxs(p: BurnParams): TransactionInstruction[] {
  if (p.amount <= 0n) {
    throw new Error("burn: amount must be positive");
  }
  if (p.amount > p.vaultTokenBalance) {
    throw new Error(
      `burn: ${p.amount} exceeds treasury balance ${p.vaultTokenBalance}`,
    );
  }
  const vaultAta = getAssociatedTokenAddressSync(
    p.mint,
    p.vault,
    true,
    p.tokenProgram,
  );
  return [
    createBurnInstruction(vaultAta, p.mint, p.vault, p.amount, [], p.tokenProgram),
  ];
}
