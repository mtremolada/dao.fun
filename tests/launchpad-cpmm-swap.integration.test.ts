/**
 * Terminal T4 — post-graduation swaps, proven against the DEPLOYED Raydium
 * CPMM binary (house rule D-031/D-034: public source is not evidence).
 *
 * A coin is graduated the same way production does it (create → whale buy to
 * completion → permissionless migrate), then the SDK's Raydium surface is
 * held to exact equality against what the binary actually does:
 *
 *   - `decodeCpmmPool` offsets: every decoded field is compared against the
 *     pool accounts OUR migrate derived — on a PoolState the deployed
 *     `initialize` wrote, not a synthetic buffer.
 *   - `cpmmSwapBaseInputQuote` rounding: each swap passes the quote as
 *     `minimum_amount_out`, and the balance delta is asserted EQUAL to the
 *     quote — if the binary paid one lamport less, the tx itself fails; if
 *     one more, the assertion does.
 *   - Fee bookkeeping: the second swap quotes from reserves that must be
 *     adjusted for the protocol/fund fees the first swap parked in the
 *     vaults (`cpmmPoolReserves`) — quoting from raw vault balances would
 *     overquote and fail the slippage check, so the wSOL→coin→wSOL round
 *     trip pins that adjustment too.
 *   - The +1 lamport slippage refusal, and the wSOL-as-token_0 ordering.
 *
 * Fixture rebuild command: see tests/helpers/launchpad-harness.ts.
 * Run: pnpm test:integration
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { ProgramTestContext } from "solana-bankrun";
import { PUMP_CLASSIC } from "../packages/sdk/src/curve-math";
import { RAYDIUM_CPMM_PROGRAM_ID } from "../packages/sdk/src/constants";
import {
  CPMM_STATUS_SWAP_DISABLED,
  buildCpmmSwapBaseInputIx,
  cpmmPoolReserves,
  cpmmSwapBaseInputQuote,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  type DecodedCpmmPool,
} from "../packages/sdk/src/launchpad";
import {
  TEST_TIMEOUT,
  send,
  sendExpectFail,
  warpSeconds,
} from "./helpers/bankrun-harness";
import {
  buyIx,
  cpmmPoolAccounts,
  createCoinIx,
  grindMint,
  initializeConfigIx,
  migrateIx,
  readCurve,
  startLaunchpadCtx,
  tokenBalance,
} from "./helpers/launchpad-harness";

describe("launchpad — in-terminal swaps on the graduated CPMM pool", () => {
  let ctx: ProgramTestContext;
  const authority = Keypair.generate();
  const feeRecipient = Keypair.generate();
  let cuNonce = 0;

  const cu = () =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + cuNonce++ });

  async function fund(target: PublicKey, lamports: number) {
    await send(
      ctx,
      [
        cu(),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: target,
          lamports,
        }),
      ],
      [],
    );
  }

  beforeAll(async () => {
    ctx = await startLaunchpadCtx();
    await send(
      ctx,
      [
        cu(),
        initializeConfigIx({
          payer: ctx.payer.publicKey,
          authority: authority.publicKey,
          feeRecipient: feeRecipient.publicKey,
          params: PUMP_CLASSIC,
        }),
      ],
      [authority],
    );
    await fund(feeRecipient.publicKey, 890_880);
  }, TEST_TIMEOUT);

  /** create → complete → migrate, then open the pool (open_time = now + 1). */
  async function graduateCoin(belowWsol: boolean): Promise<Keypair> {
    const mint = grindMint(belowWsol);
    const creator = Keypair.generate();
    const whale = Keypair.generate();
    await fund(whale.publicKey, 120_000_000_000);
    await send(
      ctx,
      [
        cu(),
        createCoinIx({
          payer: ctx.payer.publicKey,
          mint: mint.publicKey,
          creator: creator.publicKey,
        }),
      ],
      [mint],
    );
    await send(
      ctx,
      [
        cu(),
        buyIx({
          user: whale.publicKey,
          mint: mint.publicKey,
          creator: creator.publicKey,
          feeRecipient: feeRecipient.publicKey,
          tokenAmount: PUMP_CLASSIC.initialRealToken,
          maxSolCost: 120_000_000_000n,
        }),
      ],
      [whale],
    );
    const cranker = Keypair.generate();
    await fund(cranker.publicKey, 1_000_000_000);
    await send(
      ctx,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 + cuNonce++ }),
        migrateIx({
          payer: cranker.publicKey,
          mint: mint.publicKey,
          feeRecipient: feeRecipient.publicKey,
        }),
      ],
      [cranker],
    );
    await warpSeconds(ctx, 2);
    return mint;
  }

  async function readPool(poolState: PublicKey): Promise<DecodedCpmmPool> {
    const info = await ctx.banksClient.getAccount(poolState);
    if (!info) throw new Error("pool state missing");
    return decodeCpmmPool(Buffer.from(info.data));
  }

  /** One exact-match swap; returns the amount the pool paid out. */
  async function swapExact(args: {
    trader: Keypair;
    poolState: PublicKey;
    inputMint: PublicKey;
    inputTokenAccount: PublicKey;
    outputTokenAccount: PublicKey;
    amountIn: bigint;
  }): Promise<bigint> {
    const pool = await readPool(args.poolState);
    const cfgInfo = await ctx.banksClient.getAccount(pool.ammConfig);
    const cfg = decodeCpmmAmmConfig(Buffer.from(cfgInfo!.data));
    const { reserve0, reserve1 } = cpmmPoolReserves(
      pool,
      await tokenBalance(ctx, pool.token0Vault),
      await tokenBalance(ctx, pool.token1Vault),
    );
    const zeroForOne = args.inputMint.equals(pool.token0Mint);
    const quote = cpmmSwapBaseInputQuote({
      amountIn: args.amountIn,
      inputReserve: zeroForOne ? reserve0 : reserve1,
      outputReserve: zeroForOne ? reserve1 : reserve0,
      tradeFeeRate: cfg.tradeFeeRate,
    });

    const before = await tokenBalance(ctx, args.outputTokenAccount);
    await send(
      ctx,
      [
        cu(),
        buildCpmmSwapBaseInputIx({
          payer: args.trader.publicKey,
          cpmmProgram: RAYDIUM_CPMM_PROGRAM_ID,
          poolState: args.poolState,
          pool,
          inputMint: args.inputMint,
          inputTokenAccount: args.inputTokenAccount,
          outputTokenAccount: args.outputTokenAccount,
          amountIn: args.amountIn,
          // The quote IS the floor: one lamport less and the binary refuses.
          minimumAmountOut: quote.amountOut,
        }),
      ],
      [args.trader],
    );
    const paid = (await tokenBalance(ctx, args.outputTokenAccount)) - before;
    // ... and the assertion catches it paying one more.
    expect(paid).toBe(quote.amountOut);
    return paid;
  }

  for (const belowWsol of [false, true]) {
    it(
      `round-trips wSOL→coin→wSOL exactly as quoted (mint ${belowWsol ? "below" : "above"} wSOL)`,
      async () => {
        const mint = await graduateCoin(belowWsol);
        const derived = cpmmPoolAccounts(mint.publicKey);

        // Decoder offsets, proven on a PoolState the deployed binary wrote.
        const pool = await readPool(derived.poolState);
        expect(pool.token0Vault.equals(derived.vault0)).toBe(true);
        expect(pool.token1Vault.equals(derived.vault1)).toBe(true);
        expect(pool.lpMint.equals(derived.lpMint)).toBe(true);
        expect(pool.token0Mint.equals(derived.mint0)).toBe(true);
        expect(pool.token1Mint.equals(derived.mint1)).toBe(true);
        expect(pool.observationKey.equals(derived.observation)).toBe(true);
        expect(pool.status & CPMM_STATUS_SWAP_DISABLED).toBe(0);
        expect(pool.protocolFeesToken0).toBe(0n);
        expect(pool.protocolFeesToken1).toBe(0n);
        const wsolDecimals = derived.wsolIsToken0 ? pool.mint0Decimals : pool.mint1Decimals;
        const coinDecimals = derived.wsolIsToken0 ? pool.mint1Decimals : pool.mint0Decimals;
        expect(wsolDecimals).toBe(9);
        expect(coinDecimals).toBe(6);

        // The pool holds the completed raise minus the migration overhead —
        // the reserves the first quote will price against.
        const migrated = await readCurve(ctx, mint.publicKey);
        expect(migrated.migrated).toBe(true);

        const trader = Keypair.generate();
        await fund(trader.publicKey, 10_000_000_000);
        const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, trader.publicKey);
        const coinAta = getAssociatedTokenAddressSync(mint.publicKey, trader.publicKey);
        const amountIn = 1_000_000_000n; // 1 SOL
        await send(
          ctx,
          [
            cu(),
            createAssociatedTokenAccountIdempotentInstruction(
              trader.publicKey,
              wsolAta,
              trader.publicKey,
              NATIVE_MINT,
            ),
            createAssociatedTokenAccountIdempotentInstruction(
              trader.publicKey,
              coinAta,
              trader.publicKey,
              mint.publicKey,
            ),
            SystemProgram.transfer({
              fromPubkey: trader.publicKey,
              toPubkey: wsolAta,
              lamports: Number(amountIn),
            }),
            createSyncNativeInstruction(wsolAta),
          ],
          [trader],
        );

        // Buy: wSOL → coin, exact.
        const tokensBought = await swapExact({
          trader,
          poolState: derived.poolState,
          inputMint: NATIVE_MINT,
          inputTokenAccount: wsolAta,
          outputTokenAccount: coinAta,
          amountIn,
        });
        expect(tokensBought > 0n).toBe(true);
        expect(await tokenBalance(ctx, wsolAta)).toBe(0n);

        // The first swap parked protocol+fund fees in the input vault; the
        // sell quote only matches if cpmmPoolReserves subtracts them.
        const after = await readPool(derived.poolState);
        const wsolProtocolFees = derived.wsolIsToken0
          ? after.protocolFeesToken0 + after.fundFeesToken0
          : after.protocolFeesToken1 + after.fundFeesToken1;
        expect(wsolProtocolFees > 0n).toBe(true);

        // Sell it all back: coin → wSOL, exact against adjusted reserves.
        const solBack = await swapExact({
          trader,
          poolState: derived.poolState,
          inputMint: mint.publicKey,
          inputTokenAccount: coinAta,
          outputTokenAccount: wsolAta,
          amountIn: tokensBought,
        });
        expect(await tokenBalance(ctx, coinAta)).toBe(0n);
        // Round trip loses exactly the two trade fees plus rounding — never gains.
        expect(solBack < amountIn).toBe(true);
        expect(solBack > (amountIn * 99n) / 100n).toBe(true); // ~0.5% total fees

        // A quote overstated by one lamport must be refused by the binary.
        await send(
          ctx,
          [
            cu(),
            SystemProgram.transfer({
              fromPubkey: trader.publicKey,
              toPubkey: wsolAta,
              lamports: 1_000_000,
            }),
            createSyncNativeInstruction(wsolAta),
          ],
          [trader],
        );
        const poolNow = await readPool(derived.poolState);
        const cfgInfo = await ctx.banksClient.getAccount(poolNow.ammConfig);
        const cfg = decodeCpmmAmmConfig(Buffer.from(cfgInfo!.data));
        const { reserve0, reserve1 } = cpmmPoolReserves(
          poolNow,
          await tokenBalance(ctx, poolNow.token0Vault),
          await tokenBalance(ctx, poolNow.token1Vault),
        );
        const wsolIsToken0 = NATIVE_MINT.equals(poolNow.token0Mint);
        const q = cpmmSwapBaseInputQuote({
          amountIn: 1_000_000n,
          inputReserve: wsolIsToken0 ? reserve0 : reserve1,
          outputReserve: wsolIsToken0 ? reserve1 : reserve0,
          tradeFeeRate: cfg.tradeFeeRate,
        });
        const logs = await sendExpectFail(
          ctx,
          [
            cu(),
            buildCpmmSwapBaseInputIx({
              payer: trader.publicKey,
              cpmmProgram: RAYDIUM_CPMM_PROGRAM_ID,
              poolState: derived.poolState,
              pool: poolNow,
              inputMint: NATIVE_MINT,
              inputTokenAccount: wsolAta,
              outputTokenAccount: coinAta,
              amountIn: 1_000_000n,
              minimumAmountOut: q.amountOut + 1n,
            }),
          ],
          [trader],
        );
        expect(logs).toMatch(/slippage|ExceededSlippage/i);
      },
      TEST_TIMEOUT,
    );
  }
});
