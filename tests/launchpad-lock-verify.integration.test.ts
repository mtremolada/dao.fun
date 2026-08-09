/**
 * G0 — verify Raydium's DEPLOYED liquidity-lock program before any launchpad
 * code depends on it (PLAN-GRADUATED-FEES.md §5; the D-031/D-032 house rule
 * that a public repo, an SDK, and even an on-chain IDL are descriptions, not
 * evidence about what the binary enforces).
 *
 * `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` (dumped at deploy slot
 * 362,025,476) is the program that turns a graduated pool from "LP burned,
 * fees lost forever" into "LP locked, fees claimable forever". Everything the
 * design in PLAN-GRADUATED-FEES.md §3 rests on is measured here:
 *
 *   1. the discriminators and the two account orders, hand-built from the
 *      on-chain IDL and run against the binary;
 *   2. that `fee_nft_owner` never signs at lock time, so the fee key can be
 *      minted straight to a PDA that did not exist as a signer;
 *   3. that `recipient_token_0/1_account` are UNCONSTRAINED — the collector
 *      names them, which is what lets our program hard-wire them to the
 *      coin's creator (a DAO treasury vault) and make the crank permissionless;
 *   4. that the fee key, and only the fee key, authorizes collection;
 *   5. that a PROGRAM-DERIVED owner can collect via invoke_signed — proven by
 *      routing the collect through a Squads vault PDA, which is the exact
 *      shape a dao.fun treasury has;
 *   6. that the lock is irreversible: the binary's dispatcher has no unlock,
 *      withdraw, or close entrypoint, and CPMM will not withdraw the locked
 *      LP for anyone;
 *   7. the rent and compute a lock and a collect actually cost;
 *   8. that `fee_nft_mint` — the one slot that MUST sign — accepts a PDA, so
 *      `migrate` needs no extra ephemeral keypair signature and the fee key
 *      lands at an address derivable from the coin mint.
 *
 * Nothing here imports our program. The CPMM swap builder IS imported — it is
 * already binary-proven (launchpad-cpmm-swap.integration.test.ts) and is only
 * used to make real trading fees for the lock program to pay out.
 *
 * Fixtures (rebuild): SOLANA_RPC_URL=<mainnet> npx tsx scripts/dump-mainnet-programs.ts
 * Run: pnpm test:integration
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import type { AddedAccount, ProgramTestContext } from "solana-bankrun";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_AMM_CONFIG,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LOCK_CP_AUTHORITY,
  RAYDIUM_LOCK_PROGRAM_ID,
  RAYDIUM_LOCK_VERIFIED_SLOT,
  SQUADS_V4_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import { wrap } from "../packages/sdk/src/execution-adapter";
import {
  buildCpmmSwapBaseInputIx,
  decodeCpmmPool,
} from "../packages/sdk/src/launchpad";
import {
  TEST_TIMEOUT,
  balance,
  send,
  sendExpectFail,
  sendMeasured,
  sendWithAlt,
  squadsConfig,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const FIXTURES = resolve(__dirname, "fixtures");

/** Anchor: sha256("global:<snake_case_name>")[0..8]. */
const anchorDisc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const CPMM_INITIALIZE_DISC = Buffer.from([175, 175, 109, 31, 13, 152, 155, 237]);
const CPMM_WITHDRAW_DISC = anchorDisc("withdraw");

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const RENT_SYSVAR = new PublicKey(
  "SysvarRent111111111111111111111111111111111",
);
/** `fee_lp_amount` sentinel live mainnet collects use: claim everything. */
const CLAIM_ALL = 0xffffffffffffffffn;

/** LockedCpLiquidityState — IDL field order, 8-byte Anchor discriminator. */
const LOCKED_CP_LIQUIDITY_LEN = 8 + 8 * 4 + 16 + 8 + 32 * 4 + 8 * 8;

interface LockedCpLiquidity {
  lockedLpAmount: bigint;
  claimedLpAmount: bigint;
  unclaimedLpAmount: bigint;
  lastLp: bigint;
  lastK: bigint;
  recentEpoch: bigint;
  poolId: PublicKey;
  feeNftMint: PublicKey;
  lockedOwner: PublicKey;
  lockedLpMint: PublicKey;
}

function decodeLockedCpLiquidity(data: Buffer): LockedCpLiquidity {
  const u128 = (o: number) =>
    data.readBigUInt64LE(o) | (data.readBigUInt64LE(o + 8) << 64n);
  return {
    lockedLpAmount: data.readBigUInt64LE(8),
    claimedLpAmount: data.readBigUInt64LE(16),
    unclaimedLpAmount: data.readBigUInt64LE(24),
    lastLp: data.readBigUInt64LE(32),
    lastK: u128(40),
    recentEpoch: data.readBigUInt64LE(56),
    poolId: new PublicKey(data.subarray(64, 96)),
    feeNftMint: new PublicKey(data.subarray(96, 128)),
    lockedOwner: new PublicKey(data.subarray(128, 160)),
    lockedLpMint: new PublicKey(data.subarray(160, 192)),
  };
}

const cpmmPda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM_PROGRAM_ID)[0];

const lockedLiquidityPda = (feeNftMint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("locked_liquidity"), feeNftMint.toBuffer()],
    RAYDIUM_LOCK_PROGRAM_ID,
  )[0];

const metaplexMetadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  )[0];

const ata = (mint: PublicKey, owner: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true);

function cpmmFixtureAccounts(): AddedAccount[] {
  return (
    JSON.parse(
      readFileSync(join(FIXTURES, "cpmm-accounts.json"), "utf8"),
    ) as { address: string; owner: string; lamports: number; dataBase64: string }[]
  ).map((a) => ({
    address: new PublicKey(a.address),
    info: {
      lamports: a.lamports,
      data: Buffer.from(a.dataBase64, "base64"),
      owner: new PublicKey(a.owner),
      executable: false,
    },
  }));
}

interface Pool {
  poolState: PublicKey;
  lpMint: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  coinMint: PublicKey;
  creatorLp: PublicKey;
  lpAmount: bigint;
}

/**
 * The 19 accounts of `lock_cp_liquidity` in IDL order, longhand so interface
 * drift shows up as a readable diff rather than a silent reshuffle.
 */
function lockCpLiquidityIx(args: {
  payer: PublicKey;
  liquidityOwner: PublicKey;
  feeNftOwner: PublicKey;
  feeNftMint: PublicKey;
  pool: Pool;
  liquidityOwnerLp: PublicKey;
  lpAmount: bigint;
  withMetadata: boolean;
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 1);
  anchorDisc("lock_cp_liquidity").copy(data, 0);
  data.writeBigUInt64LE(args.lpAmount, 8);
  data.writeUInt8(args.withMetadata ? 1 : 0, 16);
  const p = args.pool;
  return new TransactionInstruction({
    programId: RAYDIUM_LOCK_PROGRAM_ID,
    data,
    keys: [
      { pubkey: RAYDIUM_LOCK_CP_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.liquidityOwner, isSigner: true, isWritable: false },
      // NOT a signer: the fee key can be minted to an address that never
      // authorized anything — the property our fee-authority PDA needs.
      { pubkey: args.feeNftOwner, isSigner: false, isWritable: false },
      { pubkey: args.feeNftMint, isSigner: true, isWritable: true },
      {
        pubkey: ata(args.feeNftMint, args.feeNftOwner),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.poolState, isSigner: false, isWritable: false },
      {
        pubkey: lockedLiquidityPda(args.feeNftMint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.lpMint, isSigner: false, isWritable: false },
      { pubkey: args.liquidityOwnerLp, isSigner: false, isWritable: true },
      {
        pubkey: ata(p.lpMint, RAYDIUM_LOCK_CP_AUTHORITY),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.vault0, isSigner: false, isWritable: true },
      { pubkey: p.vault1, isSigner: false, isWritable: true },
      {
        pubkey: metaplexMetadataPda(args.feeNftMint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: MPL_TOKEN_METADATA_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
  });
}

/** The 18 accounts of `collect_cp_fees` in IDL order. */
function collectCpFeesIx(args: {
  feeNftOwner: PublicKey;
  feeNftMint: PublicKey;
  feeNftAccount?: PublicKey;
  pool: Pool;
  recipient0: PublicKey;
  recipient1: PublicKey;
  feeLpAmount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 8);
  anchorDisc("collect_cp_fees").copy(data, 0);
  data.writeBigUInt64LE(args.feeLpAmount, 8);
  const p = args.pool;
  return new TransactionInstruction({
    programId: RAYDIUM_LOCK_PROGRAM_ID,
    data,
    keys: [
      { pubkey: RAYDIUM_LOCK_CP_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: args.feeNftOwner, isSigner: true, isWritable: false },
      {
        pubkey: args.feeNftAccount ?? ata(args.feeNftMint, args.feeNftOwner),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: lockedLiquidityPda(args.feeNftMint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: RAYDIUM_CPMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: p.poolState, isSigner: false, isWritable: true },
      { pubkey: p.lpMint, isSigner: false, isWritable: true },
      { pubkey: args.recipient0, isSigner: false, isWritable: true },
      { pubkey: args.recipient1, isSigner: false, isWritable: true },
      { pubkey: p.vault0, isSigner: false, isWritable: true },
      { pubkey: p.vault1, isSigner: false, isWritable: true },
      { pubkey: p.mint0, isSigner: false, isWritable: false },
      { pubkey: p.mint1, isSigner: false, isWritable: false },
      {
        pubkey: ata(p.lpMint, RAYDIUM_LOCK_CP_AUTHORITY),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
  });
}

describe("Raydium liquidity lock — deployed-binary interface verification (G0)", () => {
  let ctx: ProgramTestContext;
  let cuNonce = 0;
  const cu = (units = 400_000) =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: units + cuNonce++ });

  beforeAll(async () => {
    ctx = await startCtx(
      [
        { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
        { name: "raydium_lock", programId: RAYDIUM_LOCK_PROGRAM_ID },
        { name: "mpl_token_metadata", programId: MPL_TOKEN_METADATA_PROGRAM_ID },
      ],
      cpmmFixtureAccounts(),
    );
  }, TEST_TIMEOUT);

  async function tokenAmount(address: PublicKey): Promise<bigint> {
    const info = await ctx.banksClient.getAccount(address);
    return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
  }

  async function mintSupply(mint: PublicKey): Promise<bigint> {
    const info = await ctx.banksClient.getAccount(mint);
    if (!info) throw new Error(`mint ${mint.toBase58()} missing`);
    return Buffer.from(info.data).readBigUInt64LE(36);
  }

  async function readLocked(feeNftMint: PublicKey): Promise<LockedCpLiquidity> {
    const info = await ctx.banksClient.getAccount(lockedLiquidityPda(feeNftMint));
    if (!info) throw new Error("locked-liquidity record missing");
    return decodeLockedCpLiquidity(Buffer.from(info.data));
  }

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

  /** A CPMM pool seeded the way a graduation seeds one; LP sits with payer. */
  async function makePool(): Promise<Pool> {
    const coin = Keypair.generate();
    const amountCoin = 206_900_000_000_000n;
    const amountSol = 84_800_000_000n;
    const coinAta = ata(coin.publicKey, ctx.payer.publicKey);
    const wsolAta = ata(NATIVE_MINT, ctx.payer.publicKey);
    const rent = Number(
      (await ctx.banksClient.getRent()).minimumBalance(BigInt(MINT_SIZE)),
    );
    await send(
      ctx,
      [
        cu(),
        SystemProgram.createAccount({
          fromPubkey: ctx.payer.publicKey,
          newAccountPubkey: coin.publicKey,
          lamports: rent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          coin.publicKey,
          6,
          ctx.payer.publicKey,
          null,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          coinAta,
          ctx.payer.publicKey,
          coin.publicKey,
        ),
        createMintToInstruction(
          coin.publicKey,
          coinAta,
          ctx.payer.publicKey,
          amountCoin,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          wsolAta,
          ctx.payer.publicKey,
          NATIVE_MINT,
        ),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: wsolAta,
          lamports: Number(amountSol),
        }),
        createSyncNativeInstruction(wsolAta),
      ],
      [coin],
    );

    const wsolIsToken0 =
      Buffer.compare(NATIVE_MINT.toBuffer(), coin.publicKey.toBuffer()) < 0;
    const [mint0, mint1] = wsolIsToken0
      ? [NATIVE_MINT, coin.publicKey]
      : [coin.publicKey, NATIVE_MINT];
    const [token0, token1] = wsolIsToken0 ? [wsolAta, coinAta] : [coinAta, wsolAta];
    const [amount0, amount1] = wsolIsToken0
      ? [amountSol, amountCoin]
      : [amountCoin, amountSol];

    const poolKey = Keypair.generate();
    const poolState = poolKey.publicKey;
    const lpMint = cpmmPda([Buffer.from("pool_lp_mint"), poolState.toBuffer()]);
    const accounts = {
      lpMint,
      vault0: cpmmPda([
        Buffer.from("pool_vault"),
        poolState.toBuffer(),
        mint0.toBuffer(),
      ]),
      vault1: cpmmPda([
        Buffer.from("pool_vault"),
        poolState.toBuffer(),
        mint1.toBuffer(),
      ]),
      observation: cpmmPda([Buffer.from("observation"), poolState.toBuffer()]),
      creatorLp: ata(lpMint, ctx.payer.publicKey),
    };

    const data = Buffer.alloc(8 + 24);
    CPMM_INITIALIZE_DISC.copy(data, 0);
    data.writeBigUInt64LE(amount0, 8);
    data.writeBigUInt64LE(amount1, 16);
    data.writeBigUInt64LE(0n, 24);
    await send(
      ctx,
      [
        cu(),
        new TransactionInstruction({
          programId: RAYDIUM_CPMM_PROGRAM_ID,
          data,
          keys: [
            { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
            { pubkey: RAYDIUM_CPMM_AMM_CONFIG, isSigner: false, isWritable: false },
            { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: poolState, isSigner: true, isWritable: true },
            { pubkey: mint0, isSigner: false, isWritable: false },
            { pubkey: mint1, isSigner: false, isWritable: false },
            { pubkey: accounts.lpMint, isSigner: false, isWritable: true },
            { pubkey: token0, isSigner: false, isWritable: true },
            { pubkey: token1, isSigner: false, isWritable: true },
            { pubkey: accounts.creatorLp, isSigner: false, isWritable: true },
            { pubkey: accounts.vault0, isSigner: false, isWritable: true },
            { pubkey: accounts.vault1, isSigner: false, isWritable: true },
            {
              pubkey: RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
              isSigner: false,
              isWritable: true,
            },
            { pubkey: accounts.observation, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            {
              pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
              isSigner: false,
              isWritable: false,
            },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
          ],
        }),
      ],
      [poolKey],
    );
    await warpSeconds(ctx, 2);

    return {
      poolState,
      ...accounts,
      mint0,
      mint1,
      coinMint: coin.publicKey,
      lpAmount: await tokenAmount(accounts.creatorLp),
    };
  }

  /** Trades both directions so the locked position has real fees to pay out. */
  async function tradeForFees(pool: Pool, rounds = 3) {
    const trader = Keypair.generate();
    await fund(trader.publicKey, 60_000_000_000);
    const wsolAta = ata(NATIVE_MINT, trader.publicKey);
    const coinAta = ata(pool.coinMint, trader.publicKey);
    const perRound = 10_000_000_000n;
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
          pool.coinMint,
        ),
      ],
      [trader],
    );
    for (let i = 0; i < rounds; i += 1) {
      await send(
        ctx,
        [
          cu(),
          SystemProgram.transfer({
            fromPubkey: trader.publicKey,
            toPubkey: wsolAta,
            lamports: Number(perRound),
          }),
          createSyncNativeInstruction(wsolAta),
        ],
        [trader],
      );
      const info = await ctx.banksClient.getAccount(pool.poolState);
      const decoded = decodeCpmmPool(Buffer.from(info!.data));
      await send(
        ctx,
        [
          cu(),
          buildCpmmSwapBaseInputIx({
            payer: trader.publicKey,
            cpmmProgram: RAYDIUM_CPMM_PROGRAM_ID,
            poolState: pool.poolState,
            pool: decoded,
            inputMint: NATIVE_MINT,
            inputTokenAccount: wsolAta,
            outputTokenAccount: coinAta,
            amountIn: perRound,
            minimumAmountOut: 0n,
          }),
        ],
        [trader],
      );
      const back = await tokenAmount(coinAta);
      const info2 = await ctx.banksClient.getAccount(pool.poolState);
      await send(
        ctx,
        [
          cu(),
          buildCpmmSwapBaseInputIx({
            payer: trader.publicKey,
            cpmmProgram: RAYDIUM_CPMM_PROGRAM_ID,
            poolState: pool.poolState,
            pool: decodeCpmmPool(Buffer.from(info2!.data)),
            inputMint: pool.coinMint,
            inputTokenAccount: coinAta,
            outputTokenAccount: wsolAta,
            amountIn: back,
            minimumAmountOut: 0n,
          }),
        ],
        [trader],
      );
    }
  }

  /** Locks 100% of the payer's LP; returns the fee-NFT mint. */
  async function lockAll(
    pool: Pool,
    feeNftOwner: PublicKey,
    withMetadata = true,
  ): Promise<{ feeNftMint: Keypair; cost: number; computeUnits: bigint }> {
    const feeNftMint = Keypair.generate();
    const before = await balance(ctx, ctx.payer.publicKey);
    const computeUnits = await sendMeasured(
      ctx,
      [
        cu(600_000),
        lockCpLiquidityIx({
          payer: ctx.payer.publicKey,
          liquidityOwner: ctx.payer.publicKey,
          feeNftOwner,
          feeNftMint: feeNftMint.publicKey,
          pool,
          liquidityOwnerLp: pool.creatorLp,
          lpAmount: pool.lpAmount,
          withMetadata,
        }),
      ],
      [feeNftMint],
    );
    // payer + fee-NFT-mint signatures at 5000 lamports each.
    const cost = before - (await balance(ctx, ctx.payer.publicKey)) - 10_000;
    return { feeNftMint, cost, computeUnits };
  }

  /** A token account that is NOT an ATA and NOT owned by the collector. */
  async function rawTokenAccount(
    mint: PublicKey,
    owner: PublicKey,
  ): Promise<PublicKey> {
    const acc = Keypair.generate();
    const rent = Number(
      (await ctx.banksClient.getRent()).minimumBalance(BigInt(ACCOUNT_SIZE)),
    );
    await send(
      ctx,
      [
        cu(),
        SystemProgram.createAccount({
          fromPubkey: ctx.payer.publicKey,
          newAccountPubkey: acc.publicKey,
          lamports: rent,
          space: ACCOUNT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeAccount3Instruction(acc.publicKey, mint, owner),
      ],
      [acc],
    );
    return acc.publicKey;
  }

  /**
   * A Squads multisig with a plain keypair member — a stand-in for any
   * program that signs PDAs via invoke_signed. Returns the vault PDA, which
   * has the same custody shape as a dao.fun treasury.
   */
  async function makeVault(): Promise<{
    multisigPda: PublicKey;
    vaultPda: PublicKey;
    member: Keypair;
  }> {
    const member = Keypair.generate();
    const createKey = Keypair.generate();
    await fund(member.publicKey, 2_000_000_000);
    const [multisigPda] = multisig.getMultisigPda({
      createKey: createKey.publicKey,
    });
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
    expect(PublicKey.isOnCurve(vaultPda.toBytes())).toBe(false);
    await send(
      ctx,
      [
        cu(),
        multisig.instructions.multisigCreateV2({
          treasury: new PublicKey(squadsConfig.treasury),
          creator: ctx.payer.publicKey,
          multisigPda,
          configAuthority: null,
          threshold: 1,
          members: [
            {
              key: member.publicKey,
              permissions: multisig.types.Permissions.all(),
            },
          ],
          timeLock: 0,
          createKey: createKey.publicKey,
          rentCollector: null,
          programId: SQUADS_V4_PROGRAM_ID,
        }),
      ],
      [createKey],
    );
    return { multisigPda, vaultPda, member };
  }

  /**
   * The Squads chain for an inner set that needs EPHEMERAL SIGNERS — PDAs
   * derived from the transaction account that Squads signs for at execution.
   * The SDK's `wrap()` hardcodes ephemeralSigners: 0 (no production path
   * needs them), so this test-only variant builds the four steps by hand.
   */
  function squadsChainWithEphemeralSigner(args: {
    multisigPda: PublicKey;
    vaultPda: PublicKey;
    member: PublicKey;
    transactionIndex: bigint;
    inner: TransactionInstruction[];
  }): TransactionInstruction[] {
    const [transactionPda] = multisig.getTransactionPda({
      multisigPda: args.multisigPda,
      index: args.transactionIndex,
      programId: SQUADS_V4_PROGRAM_ID,
    });
    const [proposalPda] = multisig.getProposalPda({
      multisigPda: args.multisigPda,
      transactionIndex: args.transactionIndex,
      programId: SQUADS_V4_PROGRAM_ID,
    });
    const [ephemeralSigner] = multisig.getEphemeralSignerPda({
      transactionPda,
      ephemeralSignerIndex: 0,
      programId: SQUADS_V4_PROGRAM_ID,
    });
    const message = new TransactionMessage({
      payerKey: args.vaultPda,
      // the vault message format carries no blockhash
      recentBlockhash: "11111111111111111111111111111111",
      instructions: args.inner,
    });
    const create = multisig.instructions.vaultTransactionCreate({
      multisigPda: args.multisigPda,
      transactionIndex: args.transactionIndex,
      creator: args.member,
      rentPayer: args.member,
      vaultIndex: 0,
      ephemeralSigners: 1,
      transactionMessage: message,
      programId: SQUADS_V4_PROGRAM_ID,
    });
    const bytes =
      multisig.utils.transactionMessageToMultisigTransactionMessageBytes({
        message,
        vaultPda: args.vaultPda,
      });
    const [decoded] = multisig.types.transactionMessageBeet.deserialize(
      Buffer.from(bytes),
    );
    type IndexArg = Parameters<typeof multisig.utils.isSignerIndex>[0];
    const compiled = decoded as unknown as IndexArg;
    // Both PDAs Squads signs for must be UNmarked at transaction level.
    const signedByProgram = [args.vaultPda, ephemeralSigner];
    const anchorRemainingAccounts = decoded.accountKeys.map((key, i) => ({
      pubkey: key,
      isWritable: multisig.utils.isStaticWritableIndex(compiled, i),
      isSigner:
        multisig.utils.isSignerIndex(compiled, i) &&
        !signedByProgram.some((p) => p.equals(key)),
    }));
    return [
      create,
      multisig.instructions.proposalCreate({
        multisigPda: args.multisigPda,
        creator: args.member,
        transactionIndex: args.transactionIndex,
        programId: SQUADS_V4_PROGRAM_ID,
      }),
      multisig.instructions.proposalApprove({
        multisigPda: args.multisigPda,
        transactionIndex: args.transactionIndex,
        member: args.member,
        programId: SQUADS_V4_PROGRAM_ID,
      }),
      multisig.generated.createVaultTransactionExecuteInstruction(
        {
          multisig: args.multisigPda,
          proposal: proposalPda,
          transaction: transactionPda,
          member: args.member,
          anchorRemainingAccounts,
        },
        SQUADS_V4_PROGRAM_ID,
      ),
    ];
  }

  /** Sends each step, falling back to v0 + ALT when the account list is big. */
  async function sendChain(ixs: TransactionInstruction[], payer: Keypair) {
    for (const ix of ixs) {
      const group = [cu(800_000), ix];
      try {
        await send(ctx, group, [payer], payer);
      } catch (e) {
        if (!/too large/i.test((e as Error).message)) throw e;
        await sendWithAlt(ctx, group, payer);
      }
    }
  }

  it(
    "pins the discriminators, the authority PDA, and the record seed",
    async () => {
      // The two entrypoints, derived rather than copied from an SDK.
      expect([...anchorDisc("lock_cp_liquidity")]).toEqual([
        216, 157, 29, 78, 38, 51, 31, 26,
      ]);
      expect([...anchorDisc("collect_cp_fees")]).toEqual([
        8, 30, 51, 199, 209, 184, 247, 133,
      ]);

      // If this seed were wrong every CPI would fail with an opaque error.
      const [authority] = PublicKey.findProgramAddressSync(
        [Buffer.from("lock_cp_authority_seed")],
        RAYDIUM_LOCK_PROGRAM_ID,
      );
      expect(authority.toBase58()).toBe(RAYDIUM_LOCK_CP_AUTHORITY.toBase58());

      // The program must be loaded from the deployment we verified (D-031).
      const program = await ctx.banksClient.getAccount(RAYDIUM_LOCK_PROGRAM_ID);
      expect(program).not.toBeNull();
      expect(program!.executable).toBe(true);
      const slots = JSON.parse(
        readFileSync(join(FIXTURES, "fixture-slots.json"), "utf8"),
      ) as Record<string, { deploySlot: number } | undefined>;
      expect(slots.raydium_lock?.deploySlot).toBeGreaterThanOrEqual(
        RAYDIUM_LOCK_VERIFIED_SLOT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "locks LP to a fee key owned by an address that never signed",
    async () => {
      const pool = await makePool();
      expect(pool.lpAmount > 0n).toBe(true);

      // Stand-in for our program's ["fee-authority", mint] PDA: off the
      // ed25519 curve, so it CANNOT have produced a signature.
      const [feeAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("fee-authority"), pool.coinMint.toBuffer()],
        RAYDIUM_CPMM_PROGRAM_ID,
      );
      expect(PublicKey.isOnCurve(feeAuthority.toBytes())).toBe(false);

      const { feeNftMint, cost, computeUnits } = await lockAll(pool, feeAuthority);

      // Every LP token left the owner and sits in the lock program's vault.
      expect(await tokenAmount(pool.creatorLp)).toBe(0n);
      const lockedLpVault = ata(pool.lpMint, RAYDIUM_LOCK_CP_AUTHORITY);
      expect(await tokenAmount(lockedLpVault)).toBe(pool.lpAmount);

      // The fee key: supply 1, held by the PDA, in its canonical ATA.
      expect(await mintSupply(feeNftMint.publicKey)).toBe(1n);
      expect(
        await tokenAmount(ata(feeNftMint.publicKey, feeAuthority)),
      ).toBe(1n);

      // The record: seed and every field the design reads back.
      const record = await ctx.banksClient.getAccount(
        lockedLiquidityPda(feeNftMint.publicKey),
      );
      expect(new PublicKey(record!.owner).toBase58()).toBe(
        RAYDIUM_LOCK_PROGRAM_ID.toBase58(),
      );
      expect(record!.data.length).toBe(LOCKED_CP_LIQUIDITY_LEN);
      const locked = await readLocked(feeNftMint.publicKey);
      expect(locked.lockedLpAmount).toBe(pool.lpAmount);
      expect(locked.claimedLpAmount).toBe(0n);
      expect(locked.unclaimedLpAmount).toBe(0n);
      expect(locked.poolId.toBase58()).toBe(pool.poolState.toBase58());
      expect(locked.feeNftMint.toBase58()).toBe(feeNftMint.publicKey.toBase58());
      // `locked_owner` is bookkeeping only — it is NOT the collect authority.
      expect(locked.lockedOwner.toBase58()).toBe(ctx.payer.publicKey.toBase58());
      expect(locked.lockedLpMint.toBase58()).toBe(pool.lpMint.toBase58());

      // Cost of the lock, measured: every lamport the payer spends ends up
      // sitting in an account the lock created. The migration must carry
      // this on top of the 192,156,720 `initialize` reserve (SPEC-LAUNCHPAD
      // A1), so it is pinned account by account — a Raydium or Metaplex
      // change that moves the bill fails here rather than stranding a
      // graduation halfway through.
      const created = [
        feeNftMint.publicKey,
        ata(feeNftMint.publicKey, feeAuthority),
        lockedLiquidityPda(feeNftMint.publicKey),
        lockedLpVault,
        metaplexMetadataPda(feeNftMint.publicKey),
      ];
      let rentSum = 0;
      for (const a of created) rentSum += await balance(ctx, a);
      expect(cost).toBe(rentSum);
      expect(await balance(ctx, feeNftMint.publicKey)).toBe(1_461_600); // 82B mint
      expect(await balance(ctx, ata(feeNftMint.publicKey, feeAuthority))).toBe(
        2_039_280, // 165B token account
      );
      expect(
        await balance(ctx, lockedLiquidityPda(feeNftMint.publicKey)),
      ).toBe(2_672_640); // 256B record
      expect(await balance(ctx, lockedLpVault)).toBe(2_039_280);
      // Metaplex is the expensive part, and NOT because of rent: 607 bytes
      // cost 5,115,600, and the other 10,000,000 is Metaplex's flat
      // create-metadata fee parked in the account.
      const metadata = await ctx.banksClient.getAccount(
        metaplexMetadataPda(feeNftMint.publicKey),
      );
      expect(metadata!.data.length).toBe(607);
      expect(Number(metadata!.lamports)).toBe(5_115_600 + 10_000_000);
      expect(cost).toBe(23_328_400);
      // 166,769 CU measured. migrate already sends a 1.4M budget, so the lock
      // branch fits with room to spare.
      expect(computeUnits).toBeLessThan(200_000n);
    },
    TEST_TIMEOUT,
  );

  it(
    "skips the Metaplex metadata account when with_metadata is false",
    async () => {
      const pool = await makePool();
      const owner = Keypair.generate().publicKey;
      const { feeNftMint, cost } = await lockAll(pool, owner, false);
      expect(
        await ctx.banksClient.getAccount(
          metaplexMetadataPda(feeNftMint.publicKey),
        ),
      ).toBeNull();
      // 8,212,800 = mint + fee-NFT ATA + record + locked-LP vault. Dropping
      // metadata saves 15,115,600 lamports (0.0151 SOL) per graduation —
      // two thirds of it Metaplex's flat fee, not rent. That is 8% of a
      // migration, and it buys a fee key wallets can actually name, so G1
      // keeps metadata ON; this test exists to keep the price visible.
      expect(cost).toBe(8_212_800);
      expect(await mintSupply(feeNftMint.publicKey)).toBe(1n);
    },
    TEST_TIMEOUT,
  );

  it(
    "pays fees to recipient accounts the collector names, not the NFT owner",
    async () => {
      const pool = await makePool();
      const collector = Keypair.generate();
      await fund(collector.publicKey, 1_000_000_000);
      const { feeNftMint } = await lockAll(pool, collector.publicKey);
      await tradeForFees(pool);

      // Neither recipient belongs to the fee-NFT owner: one is a stranger's
      // ATA, one is a non-ATA account owned by an off-curve PDA. If the
      // program constrained recipients, this call could not exist — and our
      // permissionless crank (destination fixed by OUR program, caller
      // arbitrary) would be impossible.
      const stranger = Keypair.generate().publicKey;
      const [pdaOwner] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury-stand-in"), pool.coinMint.toBuffer()],
        RAYDIUM_CPMM_PROGRAM_ID,
      );
      const recipient0 = await rawTokenAccount(pool.mint0, pdaOwner);
      const recipient1 = ata(pool.mint1, stranger);
      await send(
        ctx,
        [
          cu(),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            recipient1,
            stranger,
            pool.mint1,
          ),
        ],
        [],
      );

      const lockedLpVault = ata(pool.lpMint, RAYDIUM_LOCK_CP_AUTHORITY);
      const lpVaultBefore = await tokenAmount(lockedLpVault);
      const beforeLocked = await readLocked(feeNftMint.publicKey);
      const computeUnits = await sendMeasured(
        ctx,
        [
          cu(600_000),
          collectCpFeesIx({
            feeNftOwner: collector.publicKey,
            feeNftMint: feeNftMint.publicKey,
            pool,
            recipient0,
            recipient1,
            feeLpAmount: CLAIM_ALL,
          }),
        ],
        [collector],
      );

      const got0 = await tokenAmount(recipient0);
      const got1 = await tokenAmount(recipient1);
      expect(got0 > 0n).toBe(true);
      expect(got1 > 0n).toBe(true);
      // 103,408 CU measured — a collect fits inside the DEFAULT 200k budget,
      // so the permissionless crank needs no ComputeBudget instruction.
      expect(computeUnits).toBeLessThan(200_000n);

      // How the payout is actually financed — worth stating precisely,
      // because it is NOT "the LP sits there forever untouched". CPMM keeps
      // the LP share of every trade fee inside the vaults, so k grows and
      // each LP token becomes redeemable for more. Collecting burns exactly
      // the slice of LP whose redemption value equals that growth:
      //
      //   locked_lp_amount decreases, claimed_lp_amount rises by the same,
      //   and k never goes down.
      //
      // So the DEPOSITED value stays in the pool permanently (that is the
      // INV-LP-LOCKED guarantee) while the LP *count* declines by exactly
      // the fees taken. Anyone reading `locked_lp_amount` as "the liquidity
      // is shrinking" would be misreading it.
      const afterLocked = await readLocked(feeNftMint.publicKey);
      const claimed = afterLocked.claimedLpAmount - beforeLocked.claimedLpAmount;
      expect(claimed > 0n).toBe(true);
      expect(beforeLocked.lockedLpAmount - afterLocked.lockedLpAmount).toBe(
        claimed,
      );
      expect(lpVaultBefore - (await tokenAmount(lockedLpVault))).toBe(claimed);
      expect(afterLocked.lastK >= beforeLocked.lastK).toBe(true);

      // Cranking again immediately is harmless: there is nothing new to pay.
      await send(
        ctx,
        [
          cu(600_000),
          collectCpFeesIx({
            feeNftOwner: collector.publicKey,
            feeNftMint: feeNftMint.publicKey,
            pool,
            recipient0,
            recipient1,
            feeLpAmount: CLAIM_ALL,
          }),
        ],
        [collector],
      );
      expect(await tokenAmount(recipient0)).toBe(got0);
      expect(await tokenAmount(recipient1)).toBe(got1);

      // ...and the stream resumes with the next trades.
      await tradeForFees(pool, 1);
      await send(
        ctx,
        [
          cu(600_000),
          collectCpFeesIx({
            feeNftOwner: collector.publicKey,
            feeNftMint: feeNftMint.publicKey,
            pool,
            recipient0,
            recipient1,
            feeLpAmount: CLAIM_ALL,
          }),
        ],
        [collector],
      );
      expect(await tokenAmount(recipient0)).toBeGreaterThan(got0);
      expect(await tokenAmount(recipient1)).toBeGreaterThan(got1);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses a collector who does not hold the fee key",
    async () => {
      const pool = await makePool();
      const owner = Keypair.generate();
      await fund(owner.publicKey, 1_000_000_000);
      const { feeNftMint } = await lockAll(pool, owner.publicKey);
      await tradeForFees(pool, 1);

      const thief = Keypair.generate();
      await fund(thief.publicKey, 1_000_000_000);
      const r0 = await rawTokenAccount(pool.mint0, thief.publicKey);
      const r1 = await rawTokenAccount(pool.mint1, thief.publicKey);

      // Signing with their own key and their own (empty) fee-NFT account.
      const empty = await rawTokenAccount(feeNftMint.publicKey, thief.publicKey);
      const logs = await sendExpectFail(
        ctx,
        [
          cu(600_000),
          collectCpFeesIx({
            feeNftOwner: thief.publicKey,
            feeNftMint: feeNftMint.publicKey,
            feeNftAccount: empty,
            pool,
            recipient0: r0,
            recipient1: r1,
            feeLpAmount: CLAIM_ALL,
          }),
        ],
        [thief],
      );
      expect(logs).toMatch(/Error|constraint|failed/i);
      expect(await tokenAmount(r0)).toBe(0n);
      expect(await tokenAmount(r1)).toBe(0n);

      // And pointing at the REAL fee-NFT account while signing as themselves
      // is refused too — the owner of that account is checked, not just its
      // balance.
      const logs2 = await sendExpectFail(
        ctx,
        [
          cu(600_000),
          collectCpFeesIx({
            feeNftOwner: thief.publicKey,
            feeNftMint: feeNftMint.publicKey,
            pool,
            recipient0: r0,
            recipient1: r1,
            feeLpAmount: CLAIM_ALL,
          }),
        ],
        [thief],
      );
      expect(logs2).toMatch(/Error|constraint|failed/i);
      expect(await tokenAmount(r0)).toBe(0n);
    },
    TEST_TIMEOUT,
  );

  it(
    "lets a PROGRAM-DERIVED owner collect via invoke_signed",
    async () => {
      // The load-bearing custody fact: a dao.fun treasury is a Squads vault
      // PDA, and our fee-authority is a PDA of our own program. Neither can
      // ever produce an ed25519 signature — they must sign by derivation.
      // Squads is the vehicle here only because it is already loaded and
      // signs its vault PDA for arbitrary inner instructions.
      const pool = await makePool();
      const { multisigPda, vaultPda, member } = await makeVault();

      const { feeNftMint } = await lockAll(pool, vaultPda);
      expect(await tokenAmount(ata(feeNftMint.publicKey, vaultPda))).toBe(1n);
      await tradeForFees(pool);

      // Fees land in the vault's own token accounts — the DAO holds them
      // directly, no human key in the path.
      const recipient0 = ata(pool.mint0, vaultPda);
      const recipient1 = ata(pool.mint1, vaultPda);
      await send(
        ctx,
        [
          cu(),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            recipient0,
            vaultPda,
            pool.mint0,
          ),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            recipient1,
            vaultPda,
            pool.mint1,
          ),
        ],
        [],
      );

      const inner = collectCpFeesIx({
        feeNftOwner: vaultPda,
        feeNftMint: feeNftMint.publicKey,
        pool,
        recipient0,
        recipient1,
        feeLpAmount: CLAIM_ALL,
      });
      await sendChain(
        wrap([inner], {
          multisigPda,
          vaultIndex: 0,
          transactionIndex: 1n,
          member: member.publicKey,
        }),
        member,
      );

      expect(await tokenAmount(recipient0)).toBeGreaterThan(0n);
      expect(await tokenAmount(recipient1)).toBeGreaterThan(0n);
    },
    TEST_TIMEOUT,
  );

  it(
    "accepts a PDA as the fee-key mint, so no throwaway keypair need sign",
    async () => {
      // `fee_nft_mint` is the one account in `lock_cp_liquidity` that must
      // SIGN and does not exist yet. Two designs follow from whether a PDA
      // can fill that slot:
      //
      //   keypair  -> every migrate tx carries an extra ephemeral signature,
      //               and the fee key's address is random, so it has to be
      //               recorded somewhere to ever be found again;
      //   PDA      -> our program invoke_signs it, the address is derivable
      //               from the coin mint, and the crank stays single-signer.
      //
      // Squads' ephemeral signers are PDAs of the Squads program that it
      // signs for during execution — structurally identical, from the lock
      // program's side, to our program signing ["fee-nft", mint].
      const pool = await makePool();
      const { multisigPda, vaultPda, member } = await makeVault();
      const [transactionPda] = multisig.getTransactionPda({
        multisigPda,
        index: 1n,
        programId: SQUADS_V4_PROGRAM_ID,
      });
      const [feeNftMintPda] = multisig.getEphemeralSignerPda({
        transactionPda,
        ephemeralSignerIndex: 0,
        programId: SQUADS_V4_PROGRAM_ID,
      });
      expect(PublicKey.isOnCurve(feeNftMintPda.toBytes())).toBe(false);

      // The vault owns the LP and pays, exactly as our migration authority
      // PDA will.
      const vaultLp = ata(pool.lpMint, vaultPda);
      await fund(vaultPda, 200_000_000);
      await send(
        ctx,
        [
          cu(),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            vaultLp,
            vaultPda,
            pool.lpMint,
          ),
          createTransferInstruction(
            pool.creatorLp,
            vaultLp,
            ctx.payer.publicKey,
            pool.lpAmount,
          ),
        ],
        [],
      );

      await sendChain(
        squadsChainWithEphemeralSigner({
          multisigPda,
          vaultPda,
          member: member.publicKey,
          transactionIndex: 1n,
          inner: [
            lockCpLiquidityIx({
              payer: vaultPda,
              liquidityOwner: vaultPda,
              feeNftOwner: vaultPda,
              feeNftMint: feeNftMintPda,
              pool,
              liquidityOwnerLp: vaultLp,
              lpAmount: pool.lpAmount,
              // metadata off: keeps this inside one legacy transaction and
              // the CPI depth at tx -> squads -> lock.
              withMetadata: false,
            }),
          ],
        }),
        member,
      );

      // A mint that never had a private key now holds the fee key.
      expect(await mintSupply(feeNftMintPda)).toBe(1n);
      expect(await tokenAmount(ata(feeNftMintPda, vaultPda))).toBe(1n);
      expect(await tokenAmount(vaultLp)).toBe(0n);
      const locked = await readLocked(feeNftMintPda);
      expect(locked.lockedLpAmount).toBe(pool.lpAmount);
      expect(locked.feeNftMint.toBase58()).toBe(feeNftMintPda.toBase58());
      expect(locked.lockedOwner.toBase58()).toBe(vaultPda.toBase58());
    },
    TEST_TIMEOUT,
  );

  it(
    "is irreversible — no unlock entrypoint, and CPMM will not withdraw the locked LP",
    async () => {
      const pool = await makePool();
      const owner = Keypair.generate();
      await fund(owner.publicKey, 1_000_000_000);
      const { feeNftMint } = await lockAll(pool, owner.publicKey);
      const lockedLpVault = ata(pool.lpMint, RAYDIUM_LOCK_CP_AUTHORITY);
      const lockedBefore = await tokenAmount(lockedLpVault);
      expect(lockedBefore).toBe(pool.lpAmount);

      // The dispatcher has exactly four arms (the on-chain IDL). Anything
      // that would give liquidity back has no entrypoint at all — Anchor
      // rejects the discriminator before any account is even read.
      for (const name of [
        "unlock_cp_liquidity",
        "withdraw",
        "decrease_liquidity",
        "close_locked_liquidity",
        "harvest_lock_cp_liquidity",
      ]) {
        const logs = await sendExpectFail(
          ctx,
          [
            cu(),
            new TransactionInstruction({
              programId: RAYDIUM_LOCK_PROGRAM_ID,
              data: anchorDisc(name),
              keys: [
                { pubkey: owner.publicKey, isSigner: true, isWritable: true },
              ],
            }),
          ],
          [owner],
        );
        expect(logs).toMatch(/fallback|InstructionFallbackNotFound|0x65/i);
      }

      // Nor can the locked LP be redeemed at the CPMM directly: the vault
      // belongs to the lock authority, which does not sign for anybody.
      const wantLp = 1_000n;
      const data = Buffer.alloc(8 + 24);
      CPMM_WITHDRAW_DISC.copy(data, 0);
      data.writeBigUInt64LE(wantLp, 8);
      data.writeBigUInt64LE(0n, 16);
      data.writeBigUInt64LE(0n, 24);
      const r0 = await rawTokenAccount(pool.mint0, owner.publicKey);
      const r1 = await rawTokenAccount(pool.mint1, owner.publicKey);
      const logs = await sendExpectFail(
        ctx,
        [
          cu(600_000),
          new TransactionInstruction({
            programId: RAYDIUM_CPMM_PROGRAM_ID,
            data,
            keys: [
              { pubkey: owner.publicKey, isSigner: true, isWritable: false },
              { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
              { pubkey: pool.poolState, isSigner: false, isWritable: true },
              { pubkey: lockedLpVault, isSigner: false, isWritable: true },
              { pubkey: r0, isSigner: false, isWritable: true },
              { pubkey: r1, isSigner: false, isWritable: true },
              { pubkey: pool.vault0, isSigner: false, isWritable: true },
              { pubkey: pool.vault1, isSigner: false, isWritable: true },
              { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
              { pubkey: pool.lpMint, isSigner: false, isWritable: true },
              { pubkey: pool.mint0, isSigner: false, isWritable: false },
              { pubkey: pool.mint1, isSigner: false, isWritable: false },
              { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
            ],
          }),
        ],
        [owner],
      );
      expect(logs).toMatch(/Error|constraint|owner|failed/i);
      expect(await tokenAmount(lockedLpVault)).toBe(lockedBefore);
      expect((await readLocked(feeNftMint.publicKey)).lockedLpAmount).toBe(
        pool.lpAmount,
      );
    },
    TEST_TIMEOUT,
  );
});
