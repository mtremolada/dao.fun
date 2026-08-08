/**
 * Raydium CPMM read/swap surface — lets the terminal keep trading a coin
 * after it graduates, with only an RPC.
 *
 * House rule (D-031/D-034): a public source repo is not evidence about a
 * deployed program. Every byte offset and rounding rule here is proven by
 * exact-equality assertions against the deployed CPMM binary in
 * tests/launchpad-cpmm-swap.integration.test.ts — the pool is created by
 * the real `initialize`, decoded by THESE decoders, and swapped with a
 * `minimum_amount_out` equal to THIS quote, so a one-lamport disagreement
 * fails the transaction itself.
 *
 * Browser-safe: web3.js + spl-token address helpers only.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { RAYDIUM_AUTH_SEED, ixDiscriminator } from "./constants";

/** PoolState is anchor zero_copy(unsafe) => packed; 637 bytes measured (D-034). */
export const CPMM_POOL_STATE_LEN = 637;
/** AmmConfig is a plain borsh account; 236 bytes measured (D-034). */
export const CPMM_AMM_CONFIG_LEN = 236;

/** Raydium fee rates are denominated in hundredths of a bip (1e-6). */
export const CPMM_FEE_RATE_DENOMINATOR = 1_000_000n;

/** PoolState.status bit 2 set = swaps disabled. */
export const CPMM_STATUS_SWAP_DISABLED = 4;

export interface DecodedCpmmPool {
  ammConfig: PublicKey;
  poolCreator: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  lpMint: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  token0Program: PublicKey;
  token1Program: PublicKey;
  observationKey: PublicKey;
  status: number;
  mint0Decimals: number;
  mint1Decimals: number;
  lpSupply: bigint;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  openTime: bigint;
}

export function decodeCpmmPool(data: Buffer | Uint8Array): DecodedCpmmPool {
  const d = Buffer.from(data);
  if (d.length !== CPMM_POOL_STATE_LEN) {
    throw new Error(`CPMM PoolState must be ${CPMM_POOL_STATE_LEN} bytes, got ${d.length}`);
  }
  return {
    ammConfig: new PublicKey(d.subarray(8, 40)),
    poolCreator: new PublicKey(d.subarray(40, 72)),
    token0Vault: new PublicKey(d.subarray(72, 104)),
    token1Vault: new PublicKey(d.subarray(104, 136)),
    lpMint: new PublicKey(d.subarray(136, 168)),
    token0Mint: new PublicKey(d.subarray(168, 200)),
    token1Mint: new PublicKey(d.subarray(200, 232)),
    token0Program: new PublicKey(d.subarray(232, 264)),
    token1Program: new PublicKey(d.subarray(264, 296)),
    observationKey: new PublicKey(d.subarray(296, 328)),
    // auth_bump at 328
    status: d[329]!,
    // lp_mint_decimals at 330
    mint0Decimals: d[331]!,
    mint1Decimals: d[332]!,
    lpSupply: d.readBigUInt64LE(333),
    protocolFeesToken0: d.readBigUInt64LE(341),
    protocolFeesToken1: d.readBigUInt64LE(349),
    fundFeesToken0: d.readBigUInt64LE(357),
    fundFeesToken1: d.readBigUInt64LE(365),
    openTime: d.readBigUInt64LE(373),
  };
}

export interface DecodedCpmmAmmConfig {
  disableCreatePool: boolean;
  index: number;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  createPoolFee: bigint;
}

export function decodeCpmmAmmConfig(data: Buffer | Uint8Array): DecodedCpmmAmmConfig {
  const d = Buffer.from(data);
  if (d.length !== CPMM_AMM_CONFIG_LEN) {
    throw new Error(`CPMM AmmConfig must be ${CPMM_AMM_CONFIG_LEN} bytes, got ${d.length}`);
  }
  return {
    disableCreatePool: d[9] === 1,
    index: d.readUInt16LE(10),
    tradeFeeRate: d.readBigUInt64LE(12),
    protocolFeeRate: d.readBigUInt64LE(20),
    fundFeeRate: d.readBigUInt64LE(28),
    createPoolFee: d.readBigUInt64LE(36),
  };
}

/**
 * The reserves a swap actually prices against: vault balances minus the
 * protocol+fund fees parked in the vaults (Raydium's
 * `vault_amount_without_fee`). Quoting from raw vault balances overpays the
 * quote and the swap's slippage check rejects it.
 */
export function cpmmPoolReserves(
  pool: DecodedCpmmPool,
  vault0Balance: bigint,
  vault1Balance: bigint,
): { reserve0: bigint; reserve1: bigint } {
  return {
    reserve0: vault0Balance - pool.protocolFeesToken0 - pool.fundFeesToken0,
    reserve1: vault1Balance - pool.protocolFeesToken1 - pool.fundFeesToken1,
  };
}

export interface CpmmSwapQuote {
  /** What the pool pays out — the safe `minimum_amount_out`. */
  amountOut: bigint;
  /** ceil(amountIn * tradeFeeRate / 1e6), retained by the pool. */
  tradeFee: bigint;
}

/**
 * Raydium `swap_base_input` pricing: the trade fee rounds UP off the input,
 * the constant-product output rounds DOWN — both directions favor the pool,
 * and both are pinned by the integration suite's exact-match swaps.
 */
export function cpmmSwapBaseInputQuote(args: {
  amountIn: bigint;
  inputReserve: bigint;
  outputReserve: bigint;
  tradeFeeRate: bigint;
}): CpmmSwapQuote {
  const { amountIn, inputReserve, outputReserve, tradeFeeRate } = args;
  if (amountIn <= 0n) throw new Error("amountIn must be positive");
  if (inputReserve <= 0n || outputReserve <= 0n) throw new Error("empty pool reserves");
  const tradeFee =
    (amountIn * tradeFeeRate + CPMM_FEE_RATE_DENOMINATOR - 1n) / CPMM_FEE_RATE_DENOMINATOR;
  const inputNet = amountIn - tradeFee;
  const amountOut =
    inputNet <= 0n ? 0n : (outputReserve * inputNet) / (inputReserve + inputNet);
  return { amountOut, tradeFee };
}

/**
 * Hand-built `swap_base_input` (13 accounts, on-chain IDL order). The
 * input/output legs are picked by `inputMint`, which must be one of the
 * pool's two mints.
 */
export function buildCpmmSwapBaseInputIx(args: {
  payer: PublicKey;
  cpmmProgram: PublicKey;
  poolState: PublicKey;
  pool: DecodedCpmmPool;
  inputMint: PublicKey;
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  amountIn: bigint;
  minimumAmountOut: bigint;
}): TransactionInstruction {
  const { pool } = args;
  let zeroForOne: boolean;
  if (args.inputMint.equals(pool.token0Mint)) zeroForOne = true;
  else if (args.inputMint.equals(pool.token1Mint)) zeroForOne = false;
  else throw new Error(`${args.inputMint.toBase58()} is not a pool mint`);

  const [authority] = PublicKey.findProgramAddressSync([RAYDIUM_AUTH_SEED], args.cpmmProgram);
  const [inputVault, outputVault] = zeroForOne
    ? [pool.token0Vault, pool.token1Vault]
    : [pool.token1Vault, pool.token0Vault];
  const [inputProgram, outputProgram] = zeroForOne
    ? [pool.token0Program, pool.token1Program]
    : [pool.token1Program, pool.token0Program];
  const outputMint = zeroForOne ? pool.token1Mint : pool.token0Mint;

  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(args.amountIn, 0);
  data.writeBigUInt64LE(args.minimumAmountOut, 8);
  return new TransactionInstruction({
    programId: args.cpmmProgram,
    data: Buffer.concat([ixDiscriminator("swap_base_input"), data]),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: false },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: pool.ammConfig, isSigner: false, isWritable: false },
      { pubkey: args.poolState, isSigner: false, isWritable: true },
      { pubkey: args.inputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: args.outputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: inputVault, isSigner: false, isWritable: true },
      { pubkey: outputVault, isSigner: false, isWritable: true },
      { pubkey: inputProgram, isSigner: false, isWritable: false },
      { pubkey: outputProgram, isSigner: false, isWritable: false },
      { pubkey: args.inputMint, isSigner: false, isWritable: false },
      { pubkey: outputMint, isSigner: false, isWritable: false },
      { pubkey: pool.observationKey, isSigner: false, isWritable: true },
    ],
  });
}
