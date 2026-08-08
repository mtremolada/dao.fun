/**
 * Raydium CPMM read/swap surface — unit legs (tests BEFORE code, doctrine).
 *
 * The decoders are exercised against synthetic buffers whose offsets are
 * written out INDEPENDENTLY here (a copied constant can't hide a layout
 * bug), plus the real mainnet AmmConfig fixture. The quote math's rounding
 * (ceil on the trade fee, floor on the constant-product output) is pinned
 * with hand-computed vectors; the exact-equality proof against the deployed
 * binary lives in tests/launchpad-cpmm-swap.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CPMM_AMM_CONFIG_LEN,
  CPMM_POOL_STATE_LEN,
  buildCpmmSwapBaseInputIx,
  cpmmPoolReserves,
  cpmmSwapBaseInputQuote,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  ixDiscriminator,
} from "../src/launchpad";
import { RAYDIUM_CPMM_AMM_CONFIG } from "../src/constants";

const FIXTURES = join(__dirname, "..", "..", "..", "tests", "fixtures");

/** A synthetic PoolState, written field-by-field at the packed offsets. */
function poolStateBuffer(fields: {
  ammConfig: PublicKey;
  token0Vault: PublicKey;
  token1Vault: PublicKey;
  token0Mint: PublicKey;
  token1Mint: PublicKey;
  observationKey: PublicKey;
  status: number;
  protocolFeesToken0: bigint;
  protocolFeesToken1: bigint;
  fundFeesToken0: bigint;
  fundFeesToken1: bigint;
  openTime: bigint;
}): Buffer {
  const d = Buffer.alloc(CPMM_POOL_STATE_LEN);
  // 8-byte discriminator, then 10 pubkeys, then 5 u8s, then u64s — packed.
  fields.ammConfig.toBuffer().copy(d, 8);
  fields.token0Vault.toBuffer().copy(d, 72);
  fields.token1Vault.toBuffer().copy(d, 104);
  fields.token0Mint.toBuffer().copy(d, 168);
  fields.token1Mint.toBuffer().copy(d, 200);
  TOKEN_PROGRAM_ID.toBuffer().copy(d, 232);
  TOKEN_PROGRAM_ID.toBuffer().copy(d, 264);
  fields.observationKey.toBuffer().copy(d, 296);
  d[329] = fields.status;
  d[331] = 9; // mint0 decimals
  d[332] = 6; // mint1 decimals
  d.writeBigUInt64LE(123n, 333); // lp supply
  d.writeBigUInt64LE(fields.protocolFeesToken0, 341);
  d.writeBigUInt64LE(fields.protocolFeesToken1, 349);
  d.writeBigUInt64LE(fields.fundFeesToken0, 357);
  d.writeBigUInt64LE(fields.fundFeesToken1, 365);
  d.writeBigUInt64LE(fields.openTime, 373);
  return d;
}

describe("decodeCpmmPool", () => {
  it("reads every field from the packed 637-byte layout", () => {
    const f = {
      ammConfig: Keypair.generate().publicKey,
      token0Vault: Keypair.generate().publicKey,
      token1Vault: Keypair.generate().publicKey,
      token0Mint: Keypair.generate().publicKey,
      token1Mint: Keypair.generate().publicKey,
      observationKey: Keypair.generate().publicKey,
      status: 4,
      protocolFeesToken0: 11n,
      protocolFeesToken1: 22n,
      fundFeesToken0: 33n,
      fundFeesToken1: 44n,
      openTime: 1_754_000_000n,
    };
    const pool = decodeCpmmPool(poolStateBuffer(f));
    expect(pool.ammConfig.equals(f.ammConfig)).toBe(true);
    expect(pool.token0Vault.equals(f.token0Vault)).toBe(true);
    expect(pool.token1Vault.equals(f.token1Vault)).toBe(true);
    expect(pool.token0Mint.equals(f.token0Mint)).toBe(true);
    expect(pool.token1Mint.equals(f.token1Mint)).toBe(true);
    expect(pool.token0Program.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(pool.token1Program.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(pool.observationKey.equals(f.observationKey)).toBe(true);
    expect(pool.status).toBe(4);
    expect(pool.mint0Decimals).toBe(9);
    expect(pool.mint1Decimals).toBe(6);
    expect(pool.lpSupply).toBe(123n);
    expect(pool.protocolFeesToken0).toBe(11n);
    expect(pool.protocolFeesToken1).toBe(22n);
    expect(pool.fundFeesToken0).toBe(33n);
    expect(pool.fundFeesToken1).toBe(44n);
    expect(pool.openTime).toBe(1_754_000_000n);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => decodeCpmmPool(Buffer.alloc(636))).toThrow(/637/);
  });
});

describe("decodeCpmmAmmConfig", () => {
  it("decodes the REAL mainnet AmmConfig fixture to the known fee schedule", () => {
    const accounts = JSON.parse(
      readFileSync(join(FIXTURES, "cpmm-accounts.json"), "utf8"),
    ) as { address: string; dataBase64: string }[];
    const raw = accounts.find(
      (a) => a.address === RAYDIUM_CPMM_AMM_CONFIG.toBase58(),
    );
    expect(raw).toBeDefined();
    const cfg = decodeCpmmAmmConfig(Buffer.from(raw!.dataBase64, "base64"));
    expect(cfg.index).toBe(0);
    expect(cfg.disableCreatePool).toBe(false);
    expect(cfg.tradeFeeRate).toBe(2500n); // 0.25%
    expect(cfg.protocolFeeRate).toBe(120000n);
    expect(cfg.fundFeeRate).toBe(40000n);
    expect(cfg.createPoolFee).toBe(150_000_000n);
  });

  it("rejects a buffer of the wrong size", () => {
    expect(() => decodeCpmmAmmConfig(Buffer.alloc(200))).toThrow(/236/);
  });
});

describe("cpmmPoolReserves", () => {
  it("subtracts accrued protocol+fund fees from the vault balances", () => {
    const pool = decodeCpmmPool(
      poolStateBuffer({
        ammConfig: Keypair.generate().publicKey,
        token0Vault: Keypair.generate().publicKey,
        token1Vault: Keypair.generate().publicKey,
        token0Mint: Keypair.generate().publicKey,
        token1Mint: Keypair.generate().publicKey,
        observationKey: Keypair.generate().publicKey,
        status: 0,
        protocolFeesToken0: 100n,
        protocolFeesToken1: 7n,
        fundFeesToken0: 50n,
        fundFeesToken1: 3n,
        openTime: 0n,
      }),
    );
    const { reserve0, reserve1 } = cpmmPoolReserves(pool, 1_000n, 500n);
    expect(reserve0).toBe(850n);
    expect(reserve1).toBe(490n);
  });
});

describe("cpmmSwapBaseInputQuote", () => {
  // trade_fee = ceil(in * rate / 1e6); out = floor(rOut * inNet / (rIn + inNet))
  it("matches a hand-computed vector at the mainnet 0.25% fee", () => {
    const q = cpmmSwapBaseInputQuote({
      amountIn: 1_000_000_000n,
      inputReserve: 100_000_000_000n,
      outputReserve: 200_000_000_000n,
      tradeFeeRate: 2500n,
    });
    expect(q.tradeFee).toBe(2_500_000n);
    // floor(200e9 * 997_500_000 / (100e9 + 997_500_000)) = 1_975_296_418
    expect(q.amountOut).toBe(1_975_296_418n);
  });

  it("rounds the fee UP (a 1-lamport input is consumed whole by the fee)", () => {
    const q = cpmmSwapBaseInputQuote({
      amountIn: 1n,
      inputReserve: 1_000_000n,
      outputReserve: 1_000_000n,
      tradeFeeRate: 2500n,
    });
    expect(q.tradeFee).toBe(1n);
    expect(q.amountOut).toBe(0n);
  });

  it("rounds the output DOWN", () => {
    // No fee: out = floor(100 * 7 / 107) = 6 (6.54... truncated)
    const q = cpmmSwapBaseInputQuote({
      amountIn: 7n,
      inputReserve: 100n,
      outputReserve: 100n,
      tradeFeeRate: 0n,
    });
    expect(q.amountOut).toBe(6n);
  });

  it("rejects non-positive inputs and empty reserves", () => {
    expect(() =>
      cpmmSwapBaseInputQuote({
        amountIn: 0n,
        inputReserve: 1n,
        outputReserve: 1n,
        tradeFeeRate: 0n,
      }),
    ).toThrow();
    expect(() =>
      cpmmSwapBaseInputQuote({
        amountIn: 1n,
        inputReserve: 0n,
        outputReserve: 1n,
        tradeFeeRate: 0n,
      }),
    ).toThrow();
  });
});

describe("buildCpmmSwapBaseInputIx", () => {
  const cpmmProgram = Keypair.generate().publicKey;
  const poolState = Keypair.generate().publicKey;
  const pool = decodeCpmmPool(
    poolStateBuffer({
      ammConfig: Keypair.generate().publicKey,
      token0Vault: Keypair.generate().publicKey,
      token1Vault: Keypair.generate().publicKey,
      token0Mint: Keypair.generate().publicKey,
      token1Mint: Keypair.generate().publicKey,
      observationKey: Keypair.generate().publicKey,
      status: 0,
      protocolFeesToken0: 0n,
      protocolFeesToken1: 0n,
      fundFeesToken0: 0n,
      fundFeesToken1: 0n,
      openTime: 0n,
    }),
  );
  const payer = Keypair.generate().publicKey;
  const inAcc = Keypair.generate().publicKey;
  const outAcc = Keypair.generate().publicKey;

  it("lays out the 13 Swap accounts for a token0 -> token1 swap", () => {
    const ix = buildCpmmSwapBaseInputIx({
      payer,
      cpmmProgram,
      poolState,
      pool,
      inputMint: pool.token0Mint,
      inputTokenAccount: inAcc,
      outputTokenAccount: outAcc,
      amountIn: 5n,
      minimumAmountOut: 3n,
    });
    expect(ix.programId.equals(cpmmProgram)).toBe(true);
    const [authority] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_and_lp_mint_auth_seed")],
      cpmmProgram,
    );
    const expected: [PublicKey, boolean, boolean][] = [
      [payer, true, false],
      [authority, false, false],
      [pool.ammConfig, false, false],
      [poolState, false, true],
      [inAcc, false, true],
      [outAcc, false, true],
      [pool.token0Vault, false, true],
      [pool.token1Vault, false, true],
      [pool.token0Program, false, false],
      [pool.token1Program, false, false],
      [pool.token0Mint, false, false],
      [pool.token1Mint, false, false],
      [pool.observationKey, false, true],
    ];
    expect(ix.keys.length).toBe(expected.length);
    expected.forEach(([pk, signer, writable], i) => {
      expect(ix.keys[i]!.pubkey.equals(pk)).toBe(true);
      expect(ix.keys[i]!.isSigner).toBe(signer);
      expect(ix.keys[i]!.isWritable).toBe(writable);
    });
    expect(ix.data.subarray(0, 8)).toEqual(ixDiscriminator("swap_base_input"));
    expect(ix.data.readBigUInt64LE(8)).toBe(5n);
    expect(ix.data.readBigUInt64LE(16)).toBe(3n);
    expect(ix.data.length).toBe(24);
  });

  it("mirrors vaults/mints/programs for a token1 -> token0 swap", () => {
    const ix = buildCpmmSwapBaseInputIx({
      payer,
      cpmmProgram,
      poolState,
      pool,
      inputMint: pool.token1Mint,
      inputTokenAccount: inAcc,
      outputTokenAccount: outAcc,
      amountIn: 5n,
      minimumAmountOut: 3n,
    });
    expect(ix.keys[6]!.pubkey.equals(pool.token1Vault)).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(pool.token0Vault)).toBe(true);
    expect(ix.keys[10]!.pubkey.equals(pool.token1Mint)).toBe(true);
    expect(ix.keys[11]!.pubkey.equals(pool.token0Mint)).toBe(true);
  });

  it("refuses a mint that is not in the pool", () => {
    expect(() =>
      buildCpmmSwapBaseInputIx({
        payer,
        cpmmProgram,
        poolState,
        pool,
        inputMint: Keypair.generate().publicKey,
        inputTokenAccount: inAcc,
        outputTokenAccount: outAcc,
        amountIn: 5n,
        minimumAmountOut: 3n,
      }),
    ).toThrow(/not a pool mint/i);
  });

  it("checks CPMM_AMM_CONFIG_LEN pin", () => {
    expect(CPMM_AMM_CONFIG_LEN).toBe(236);
  });
});
