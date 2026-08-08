/**
 * AMM action plumbing for graduated coins: quote direction mapping, spot
 * price convention, and the exact wrap→swap→unwrap instruction assembly
 * (the swap itself is bankrun-proven in tests/launchpad-cpmm-swap).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { cpmmSwapBaseInputQuote, type DecodedCpmmPool } from "@daofun/sdk/launchpad";
import {
  ammBuyInstructions,
  ammSellInstructions,
  ammSpotPriceSol,
  quoteAmmBuy,
  quoteAmmSell,
  type AmmContext,
} from "../lib/amm-actions";

const CPMM_PROGRAM = Keypair.generate().publicKey;

function fakeContext(wsolIsToken0: boolean): { ctx: AmmContext; mint: PublicKey } {
  const mint = Keypair.generate().publicKey;
  const [mint0, mint1] = wsolIsToken0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  const pool: DecodedCpmmPool = {
    ammConfig: Keypair.generate().publicKey,
    poolCreator: Keypair.generate().publicKey,
    token0Vault: Keypair.generate().publicKey,
    token1Vault: Keypair.generate().publicKey,
    lpMint: Keypair.generate().publicKey,
    token0Mint: mint0,
    token1Mint: mint1,
    token0Program: TOKEN_PROGRAM_ID,
    token1Program: TOKEN_PROGRAM_ID,
    observationKey: Keypair.generate().publicKey,
    status: 0,
    mint0Decimals: wsolIsToken0 ? 9 : 6,
    mint1Decimals: wsolIsToken0 ? 6 : 9,
    lpSupply: 0n,
    protocolFeesToken0: 0n,
    protocolFeesToken1: 0n,
    fundFeesToken0: 0n,
    fundFeesToken1: 0n,
    openTime: 0n,
  };
  return {
    mint,
    ctx: {
      poolState: Keypair.generate().publicKey,
      cpmmProgram: CPMM_PROGRAM,
      pool,
      tradeFeeRate: 2500n,
      wsolIsToken0,
      // 80 SOL against 200M tokens (6dp) → 4e-7 SOL per whole token.
      wsolReserve: 80_000_000_000n,
      coinReserve: 200_000_000_000_000n,
    },
  };
}

describe("amm quotes", () => {
  it("prices spot as SOL per whole token across the 9/6 decimal gap", () => {
    const { ctx } = fakeContext(true);
    expect(ammSpotPriceSol(ctx)).toBeCloseTo(4e-7, 12);
  });

  for (const wsolIsToken0 of [true, false]) {
    it(`buy/sell quotes agree with the SDK swap math (wsolIsToken0=${wsolIsToken0})`, () => {
      const { ctx } = fakeContext(wsolIsToken0);
      const lamportsIn = 1_000_000_000n;
      expect(quoteAmmBuy(ctx, lamportsIn)).toBe(
        cpmmSwapBaseInputQuote({
          amountIn: lamportsIn,
          inputReserve: ctx.wsolReserve,
          outputReserve: ctx.coinReserve,
          tradeFeeRate: 2500n,
        }).amountOut,
      );
      const tokensIn = 5_000_000_000n;
      expect(quoteAmmSell(ctx, tokensIn)).toBe(
        cpmmSwapBaseInputQuote({
          amountIn: tokensIn,
          inputReserve: ctx.coinReserve,
          outputReserve: ctx.wsolReserve,
          tradeFeeRate: 2500n,
        }).amountOut,
      );
    });
  }
});

describe("amm instruction assembly", () => {
  const owner = Keypair.generate().publicKey;

  it("buy: create ATAs → fund wSOL → sync → swap → close wSOL", () => {
    const { ctx, mint } = fakeContext(false);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
    const coinAta = getAssociatedTokenAddressSync(mint, owner);
    const ixs = ammBuyInstructions({
      owner,
      mint,
      amm: ctx,
      lamportsIn: 1_000_000_000n,
      minTokensOut: 42n,
    });
    expect(ixs.length).toBe(6);
    // 0/1: idempotent ATA creates (wSOL then coin).
    expect(ixs[0]!.keys[1]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[1]!.keys[1]!.pubkey.equals(coinAta)).toBe(true);
    // 2: system transfer funds the wrap.
    expect(ixs[2]!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ixs[2]!.keys[1]!.pubkey.equals(wsolAta)).toBe(true);
    // 3: syncNative on the wSOL ATA.
    expect(ixs[3]!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[3]!.keys[0]!.pubkey.equals(wsolAta)).toBe(true);
    // 4: the swap, wSOL in → coin out, with the min-out cap.
    expect(ixs[4]!.programId.equals(CPMM_PROGRAM)).toBe(true);
    expect(ixs[4]!.keys[4]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[4]!.keys[5]!.pubkey.equals(coinAta)).toBe(true);
    expect(ixs[4]!.keys[10]!.pubkey.equals(NATIVE_MINT)).toBe(true);
    expect(ixs[4]!.keys[11]!.pubkey.equals(mint)).toBe(true);
    expect(ixs[4]!.data.readBigUInt64LE(8)).toBe(1_000_000_000n);
    expect(ixs[4]!.data.readBigUInt64LE(16)).toBe(42n);
    // 5: close the wSOL ATA back to the owner (refunds rent + dust).
    expect(ixs[5]!.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ixs[5]!.keys[0]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[5]!.keys[1]!.pubkey.equals(owner)).toBe(true);
  });

  it("sell: create wSOL ATA → swap → close (unwraps proceeds)", () => {
    const { ctx, mint } = fakeContext(true);
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
    const coinAta = getAssociatedTokenAddressSync(mint, owner);
    const ixs = ammSellInstructions({
      owner,
      mint,
      amm: ctx,
      tokensIn: 5_000_000n,
      minLamportsOut: 7n,
    });
    expect(ixs.length).toBe(3);
    expect(ixs[0]!.keys[1]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[1]!.programId.equals(CPMM_PROGRAM)).toBe(true);
    expect(ixs[1]!.keys[4]!.pubkey.equals(coinAta)).toBe(true);
    expect(ixs[1]!.keys[5]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[1]!.keys[10]!.pubkey.equals(mint)).toBe(true);
    expect(ixs[1]!.keys[11]!.pubkey.equals(NATIVE_MINT)).toBe(true);
    expect(ixs[1]!.data.readBigUInt64LE(8)).toBe(5_000_000n);
    expect(ixs[1]!.data.readBigUInt64LE(16)).toBe(7n);
    expect(ixs[2]!.keys[0]!.pubkey.equals(wsolAta)).toBe(true);
    expect(ixs[2]!.keys[1]!.pubkey.equals(owner)).toBe(true);
  });
});
