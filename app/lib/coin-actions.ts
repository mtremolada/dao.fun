/**
 * Buy / sell / create actions: quote against the SAME curve math the program
 * prices with, build the instruction with the SDK, and drive it through the
 * send pipeline. Kept out of the React components so it is plain and testable.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  buildBuyIx,
  buildCollectCreatorFeeIx,
  buildCreateCoinIx,
  buildMigrateIx,
  buildSellIx,
  decodeConfig,
  configPda,
  explainLaunchpadError,
} from "@daofun/sdk/launchpad";
import {
  buyQuote,
  sellQuote,
  tokensForSolInput,
  type CurveState,
} from "@daofun/sdk/curve-math";
import { sendTransaction, type SendRpc, type SendState, type SigningWallet } from "./tx-sender";
import { ConstantFeeEstimator } from "./fees";
import { chainId, cluster, isDevnet, launchpadProgramId } from "./cluster";
import type { CoinView } from "./launchpad-api";

const feeEstimator = new ConstantFeeEstimator();

/** Reconstruct a curve state from a board/coin view for quoting. */
export function coinState(coin: CoinView): CurveState {
  return {
    virtualSol: BigInt(coin.virtualSol),
    virtualToken: BigInt(coin.virtualToken),
    realSol: BigInt(coin.realSol),
    realToken: BigInt(coin.realToken),
    protocolFeeBps: 70,
    creatorFeeBps: 30,
    complete: coin.complete,
  };
}

let configCache: { feeRecipient: PublicKey } | null = null;
async function getFeeRecipient(connection: Connection): Promise<PublicKey> {
  if (configCache) return configCache.feeRecipient;
  const info = await connection.getAccountInfo(configPda(launchpadProgramId()));
  if (!info) throw new Error("launchpad config not found on chain");
  configCache = { feeRecipient: decodeConfig(info.data).feeRecipient };
  return configCache.feeRecipient;
}

export interface ActionCtx {
  connection: Connection;
  wallet: SigningWallet;
  onState?: (s: SendState) => void;
}

export function quoteBuy(coin: CoinView, solBudget: bigint): { tokensOut: bigint; cost: bigint } {
  const state = coinState(coin);
  const tokensOut = tokensForSolInput(state, solBudget);
  if (tokensOut <= 0n) return { tokensOut: 0n, cost: 0n };
  return { tokensOut, cost: buyQuote(state, tokensOut).totalCost };
}

export function quoteSell(coin: CoinView, tokenAmount: bigint): bigint {
  if (tokenAmount <= 0n) return 0n;
  return sellQuote(coinState(coin), tokenAmount).netSol;
}

export async function buy(
  coin: CoinView,
  args: { tokensOut: bigint; maxSolCost: bigint; slippageBps: number },
  ctx: ActionCtx,
): Promise<SendState> {
  const feeRecipient = await getFeeRecipient(ctx.connection);
  const maxSolCost = args.maxSolCost + (args.maxSolCost * BigInt(args.slippageBps)) / 10_000n;
  return sendTransaction({
    instructions: [
      buildBuyIx({
        user: new PublicKey(ctx.wallet.address),
        mint: new PublicKey(coin.mint),
        creator: new PublicKey(coin.creator),
        feeRecipient,
        tokenAmount: args.tokensOut,
        maxSolCost,
        programId: launchpadProgramId(),
      }),
    ],
    ...sendCommon(ctx),
  });
}

export async function sell(
  coin: CoinView,
  args: { tokenAmount: bigint; minSolOutput: bigint; slippageBps: number },
  ctx: ActionCtx,
): Promise<SendState> {
  const feeRecipient = await getFeeRecipient(ctx.connection);
  const minSolOutput = args.minSolOutput - (args.minSolOutput * BigInt(args.slippageBps)) / 10_000n;
  return sendTransaction({
    instructions: [
      buildSellIx({
        user: new PublicKey(ctx.wallet.address),
        mint: new PublicKey(coin.mint),
        creator: new PublicKey(coin.creator),
        feeRecipient,
        tokenAmount: args.tokenAmount,
        minSolOutput: minSolOutput < 0n ? 0n : minSolOutput,
        programId: launchpadProgramId(),
      }),
    ],
    ...sendCommon(ctx),
  });
}

/**
 * Launch a coin. Returns the send state plus the mint that was created (its
 * keypair co-signs create_coin). The metadata uri must already be uploaded.
 */
export async function createCoin(
  args: { name: string; symbol: string; uri: string; creator?: PublicKey },
  ctx: ActionCtx,
): Promise<{ state: SendState; mint: PublicKey }> {
  const mint = Keypair.generate();
  const payer = new PublicKey(ctx.wallet.address);
  const state = await sendTransaction({
    instructions: [
      buildCreateCoinIx({
        payer,
        mint: mint.publicKey,
        creator: args.creator ?? payer,
        name: args.name,
        symbol: args.symbol,
        uri: args.uri,
        programId: launchpadProgramId(),
      }),
    ],
    ...sendCommon(ctx),
    // create_coin needs the fresh mint as an extra signer, so the pipeline's
    // sign-only path must include it — handled by the extraSigners hook below.
    extraSigners: [mint],
  });
  return { state, mint: mint.publicKey };
}

/**
 * Claim the creator fees. Permissionless by design — the program fixes the
 * destination to the curve's recorded creator — so the connected wallet only
 * pays the fee; it does not need to BE the creator. One vault serves all of
 * a creator's coins, so any of their mints drains the whole balance.
 */
export async function claimCreatorFees(
  coin: CoinView,
  ctx: ActionCtx,
): Promise<SendState> {
  return sendTransaction({
    instructions: [
      buildCollectCreatorFeeIx({
        payer: new PublicKey(ctx.wallet.address),
        creator: new PublicKey(coin.creator),
        mint: new PublicKey(coin.mint),
        programId: launchpadProgramId(),
      }),
    ],
    ...sendCommon(ctx),
  });
}

/**
 * Crank a completed curve into its Raydium pool. Also permissionless: the
 * destination accounts are all derived, so anyone can pay to graduate a coin
 * that has finished its raise.
 */
export async function graduate(coin: CoinView, ctx: ActionCtx): Promise<SendState> {
  const feeRecipient = await getFeeRecipient(ctx.connection);
  return sendTransaction({
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      buildMigrateIx({
        payer: new PublicKey(ctx.wallet.address),
        mint: new PublicKey(coin.mint),
        feeRecipient,
        cluster: cluster() === "mainnet" ? "mainnet" : "devnet",
        programId: launchpadProgramId(),
      }),
    ],
    ...sendCommon(ctx),
  });
}

function sendCommon(ctx: ActionCtx) {
  return {
    wallet: ctx.wallet,
    // The real Connection implements every SendRpc method; the cast bridges
    // web3's richer overload types to the pipeline's minimal surface.
    connection: ctx.connection as unknown as SendRpc,
    chainId: chainId(),
    feeEstimator,
    explainError: explainLaunchpadError,
    preferWalletBroadcast: !isDevnet(),
    onState: ctx.onState,
  };
}

export { cluster };
