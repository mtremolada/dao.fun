/**
 * Post-graduation trading: once a coin migrates, the terminal keeps its
 * buy/sell panel live by swapping on the Raydium CPMM pool directly —
 * wrap → swap_base_input → unwrap, quoted with the SDK math that the
 * bankrun suite holds to exact equality against the deployed binary
 * (tests/launchpad-cpmm-swap.integration.test.ts).
 *
 * The CPMM program id is read from the pool account's OWNER, not a cluster
 * table — the pool exists, so its owner is the authority on which Raydium
 * deployment it belongs to.
 */
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  CPMM_POOL_STATE_LEN,
  buildCpmmSwapBaseInputIx,
  cpmmPoolReserves,
  cpmmSwapBaseInputQuote,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  explainLaunchpadError,
  poolStatePda,
  type DecodedCpmmPool,
} from "@daofun/sdk/launchpad";
import { sendTransaction, type SendRpc, type SendState, type SigningWallet } from "./tx-sender";
import { ConstantFeeEstimator } from "./fees";
import { chainId, isDevnet, launchpadProgramId } from "./cluster";
import type { CoinView } from "./launchpad-api";

const feeEstimator = new ConstantFeeEstimator();

export interface AmmContext {
  poolState: PublicKey;
  cpmmProgram: PublicKey;
  pool: DecodedCpmmPool;
  tradeFeeRate: bigint;
  wsolIsToken0: boolean;
  /** Fee-adjusted reserves (vault balance minus accrued protocol+fund fees). */
  wsolReserve: bigint;
  coinReserve: bigint;
}

/** SPL token account amount field (u64 at offset 64). */
const tokenAmount = (data: Uint8Array) => Buffer.from(data).readBigUInt64LE(64);

/**
 * Load everything a swap needs in two RPC round trips. Null when the pool
 * isn't there (not yet migrated, or a devnet reset) — callers fall back to
 * the closed-curve rendering.
 */
export async function fetchAmmContext(
  connection: Connection,
  coin: CoinView,
): Promise<AmmContext | null> {
  const poolState = coin.poolState
    ? new PublicKey(coin.poolState)
    : poolStatePda(new PublicKey(coin.mint), launchpadProgramId());
  const info = await connection.getAccountInfo(poolState);
  if (!info || info.data.length !== CPMM_POOL_STATE_LEN) return null;
  const pool = decodeCpmmPool(info.data);
  const [cfg, vault0, vault1] = await connection.getMultipleAccountsInfo([
    pool.ammConfig,
    pool.token0Vault,
    pool.token1Vault,
  ]);
  if (!cfg || !vault0 || !vault1) return null;
  const { reserve0, reserve1 } = cpmmPoolReserves(
    pool,
    tokenAmount(vault0.data),
    tokenAmount(vault1.data),
  );
  const wsolIsToken0 = pool.token0Mint.equals(NATIVE_MINT);
  return {
    poolState,
    cpmmProgram: info.owner,
    pool,
    tradeFeeRate: decodeCpmmAmmConfig(cfg.data).tradeFeeRate,
    wsolIsToken0,
    wsolReserve: wsolIsToken0 ? reserve0 : reserve1,
    coinReserve: wsolIsToken0 ? reserve1 : reserve0,
  };
}

/** SOL per whole token (coin at 6 decimals) — same convention as the curve's spot. */
export function ammSpotPriceSol(amm: AmmContext): number {
  if (amm.coinReserve === 0n) return 0;
  return Number(amm.wsolReserve) / 1e9 / (Number(amm.coinReserve) / 1e6);
}

export function quoteAmmBuy(amm: AmmContext, lamportsIn: bigint): bigint {
  if (lamportsIn <= 0n) return 0n;
  return cpmmSwapBaseInputQuote({
    amountIn: lamportsIn,
    inputReserve: amm.wsolReserve,
    outputReserve: amm.coinReserve,
    tradeFeeRate: amm.tradeFeeRate,
  }).amountOut;
}

export function quoteAmmSell(amm: AmmContext, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  return cpmmSwapBaseInputQuote({
    amountIn: tokensIn,
    inputReserve: amm.coinReserve,
    outputReserve: amm.wsolReserve,
    tradeFeeRate: amm.tradeFeeRate,
  }).amountOut;
}

export function ammBuyInstructions(args: {
  owner: PublicKey;
  mint: PublicKey;
  amm: AmmContext;
  lamportsIn: bigint;
  minTokensOut: bigint;
}): TransactionInstruction[] {
  const { owner, mint, amm } = args;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const coinAta = getAssociatedTokenAddressSync(mint, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(owner, coinAta, owner, mint),
    SystemProgram.transfer({
      fromPubkey: owner,
      toPubkey: wsolAta,
      lamports: Number(args.lamportsIn),
    }),
    createSyncNativeInstruction(wsolAta),
    buildCpmmSwapBaseInputIx({
      payer: owner,
      cpmmProgram: amm.cpmmProgram,
      poolState: amm.poolState,
      pool: amm.pool,
      inputMint: NATIVE_MINT,
      inputTokenAccount: wsolAta,
      outputTokenAccount: coinAta,
      amountIn: args.lamportsIn,
      minimumAmountOut: args.minTokensOut,
    }),
    // Close refunds the ATA rent and any wrap dust back to the owner.
    createCloseAccountInstruction(wsolAta, owner, owner),
  ];
}

export function ammSellInstructions(args: {
  owner: PublicKey;
  mint: PublicKey;
  amm: AmmContext;
  tokensIn: bigint;
  minLamportsOut: bigint;
}): TransactionInstruction[] {
  const { owner, mint, amm } = args;
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  const coinAta = getAssociatedTokenAddressSync(mint, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, wsolAta, owner, NATIVE_MINT),
    buildCpmmSwapBaseInputIx({
      payer: owner,
      cpmmProgram: amm.cpmmProgram,
      poolState: amm.poolState,
      pool: amm.pool,
      inputMint: mint,
      inputTokenAccount: coinAta,
      outputTokenAccount: wsolAta,
      amountIn: args.tokensIn,
      minimumAmountOut: args.minLamportsOut,
    }),
    // Close unwraps the wSOL proceeds (plus the ATA rent) into plain SOL.
    createCloseAccountInstruction(wsolAta, owner, owner),
  ];
}

export interface AmmActionCtx {
  connection: Connection;
  wallet: SigningWallet;
  onState?: (s: SendState) => void;
}

export async function ammBuy(
  coin: CoinView,
  args: { lamportsIn: bigint; minTokensOut: bigint; slippageBps: number },
  ctx: AmmActionCtx,
  amm: AmmContext,
): Promise<SendState> {
  const minTokensOut =
    args.minTokensOut - (args.minTokensOut * BigInt(args.slippageBps)) / 10_000n;
  return sendTransaction({
    instructions: ammBuyInstructions({
      owner: new PublicKey(ctx.wallet.address),
      mint: new PublicKey(coin.mint),
      amm,
      lamportsIn: args.lamportsIn,
      minTokensOut: minTokensOut < 0n ? 0n : minTokensOut,
    }),
    ...sendCommon(ctx),
  });
}

export async function ammSell(
  coin: CoinView,
  args: { tokensIn: bigint; minLamportsOut: bigint; slippageBps: number },
  ctx: AmmActionCtx,
  amm: AmmContext,
): Promise<SendState> {
  const minLamportsOut =
    args.minLamportsOut - (args.minLamportsOut * BigInt(args.slippageBps)) / 10_000n;
  return sendTransaction({
    instructions: ammSellInstructions({
      owner: new PublicKey(ctx.wallet.address),
      mint: new PublicKey(coin.mint),
      amm,
      tokensIn: args.tokensIn,
      minLamportsOut: minLamportsOut < 0n ? 0n : minLamportsOut,
    }),
    ...sendCommon(ctx),
  });
}

function sendCommon(ctx: AmmActionCtx) {
  return {
    wallet: ctx.wallet,
    connection: ctx.connection as unknown as SendRpc,
    chainId: chainId(),
    feeEstimator,
    explainError: explainLaunchpadError,
    preferWalletBroadcast: !isDevnet(),
    onState: ctx.onState,
  };
}
