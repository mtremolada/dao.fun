/**
 * GATE L1 leg 0 — verify the DEPLOYED Raydium CPMM interface before any
 * launchpad code depends on it (SPEC-LAUNCHPAD.md §2; DECISIONS.md D-034).
 *
 * The house rule that produced D-031/D-032: a public source repo is not
 * evidence about a deployed program. So this suite builds `initialize` by
 * hand — discriminator, argument encoding, and the 20-account list taken
 * from the on-chain IDL — and runs it against the mainnet binary dumped at
 * the exact slot our research verified (425,801,539; tests/fixtures/
 * fixture-slots.json). Nothing here imports our program or SDK: if this
 * suite is green, the graduation CPI is built on measured facts.
 *
 * What it pins, in the order the migration will need it:
 *   - the vault/LP-mint authority PDA seed and every derived-account seed,
 *   - AmmConfig's byte layout, so reading `create_pool_fee` at runtime is safe,
 *   - that plain `initialize` is permissionless (no Permission PDA),
 *   - that a NON-canonical pool_state works when it signs — the property
 *     that makes graduation unsquattable (SPEC-LAUNCHPAD A8),
 *   - LP accounting: minted = sqrt(a0*a1) - 100 (Raydium withholds 100),
 *   - the exact lamport cost of a graduation, which the curve must reserve.
 *
 * Fixtures (rebuild): SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   npx tsx scripts/dump-mainnet-programs.ts
 * Run: pnpm test:integration
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MINT_SIZE,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { AddedAccount, ProgramTestContext } from "solana-bankrun";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_AMM_CONFIG,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_VERIFIED_SLOT,
} from "../packages/sdk/src/constants";
import {
  TEST_TIMEOUT,
  balance,
  send,
  sendExpectFail,
  startCtx,
} from "./helpers/bankrun-harness";

const FIXTURES = resolve(__dirname, "fixtures");

/** `initialize` — on-chain IDL, verified byte-stable since 2024-08-30. */
const INITIALIZE_DISCRIMINATOR = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237,
]);
/** AmmConfig anchor account discriminator. */
const AMM_CONFIG_DISCRIMINATOR = [218, 244, 33, 104, 203, 203, 43, 111];

// Account sizes the program initializes — these drive the rent the curve
// must reserve before it can graduate (SPEC-LAUNCHPAD A1).
const POOL_STATE_LEN = 637;
const OBSERVATION_STATE_LEN = 4075;
const SPL_MINT_LEN = 82;
const SPL_TOKEN_ACCOUNT_LEN = 165;
/** Mainnet rent: (128 + size) * 3480 lamports/byte-year * 2 years. */
const rentFor = (size: number) => (128 + size) * 6960;
const EXPECTED_RENT_TOTAL =
  rentFor(POOL_STATE_LEN) +
  rentFor(OBSERVATION_STATE_LEN) +
  rentFor(SPL_MINT_LEN) +
  rentFor(SPL_TOKEN_ACCOUNT_LEN) * 3;
const EXPECTED_CREATE_POOL_FEE = 150_000_000;

function cpmmAccounts(): AddedAccount[] {
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

const pda = (seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM_PROGRAM_ID)[0];

/** Integer sqrt on bigints — mirrors the program's LP formula. */
function isqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

interface PoolAccounts {
  poolState: PublicKey;
  lpMint: PublicKey;
  vault0: PublicKey;
  vault1: PublicKey;
  observation: PublicKey;
  creatorLp: PublicKey;
}

function derivePoolAccounts(
  poolState: PublicKey,
  mint0: PublicKey,
  mint1: PublicKey,
  creator: PublicKey,
): PoolAccounts {
  return {
    poolState,
    lpMint: pda([Buffer.from("pool_lp_mint"), poolState.toBuffer()]),
    vault0: pda([
      Buffer.from("pool_vault"),
      poolState.toBuffer(),
      mint0.toBuffer(),
    ]),
    vault1: pda([
      Buffer.from("pool_vault"),
      poolState.toBuffer(),
      mint1.toBuffer(),
    ]),
    observation: pda([Buffer.from("observation"), poolState.toBuffer()]),
    creatorLp: getAssociatedTokenAddressSync(
      pda([Buffer.from("pool_lp_mint"), poolState.toBuffer()]),
      creator,
      true,
    ),
  };
}

/**
 * The 20 accounts in IDL order. Written out longhand (rather than generated)
 * so a future interface drift shows up as a readable diff.
 */
function initializeIx(args: {
  creator: PublicKey;
  mint0: PublicKey;
  mint1: PublicKey;
  creatorToken0: PublicKey;
  creatorToken1: PublicKey;
  accounts: PoolAccounts;
  amount0: bigint;
  amount1: bigint;
  openTime: bigint;
  poolStateIsSigner: boolean;
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 24);
  INITIALIZE_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(args.amount0, 8);
  data.writeBigUInt64LE(args.amount1, 16);
  data.writeBigUInt64LE(args.openTime, 24);
  const a = args.accounts;
  return new TransactionInstruction({
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    data,
    keys: [
      { pubkey: args.creator, isSigner: true, isWritable: true },
      { pubkey: RAYDIUM_CPMM_AMM_CONFIG, isSigner: false, isWritable: false },
      { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
      { pubkey: a.poolState, isSigner: args.poolStateIsSigner, isWritable: true },
      { pubkey: args.mint0, isSigner: false, isWritable: false },
      { pubkey: args.mint1, isSigner: false, isWritable: false },
      { pubkey: a.lpMint, isSigner: false, isWritable: true },
      { pubkey: args.creatorToken0, isSigner: false, isWritable: true },
      { pubkey: args.creatorToken1, isSigner: false, isWritable: true },
      { pubkey: a.creatorLp, isSigner: false, isWritable: true },
      { pubkey: a.vault0, isSigner: false, isWritable: true },
      { pubkey: a.vault1, isSigner: false, isWritable: true },
      {
        pubkey: RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: a.observation, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"),
        isSigner: false,
        isWritable: false,
      },
    ],
  });
}

async function tokenAmount(
  ctx: ProgramTestContext,
  address: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(address);
  if (!info) throw new Error(`token account ${address.toBase58()} missing`);
  return Buffer.from(info.data).readBigUInt64LE(64);
}

async function mintSupply(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(mint);
  if (!info) throw new Error(`mint ${mint.toBase58()} missing`);
  return Buffer.from(info.data).readBigUInt64LE(36);
}

describe("Raydium CPMM — deployed-binary interface verification", () => {
  let ctx: ProgramTestContext;
  let cuNonce = 0;

  beforeAll(async () => {
    ctx = await startCtx(
      [
        { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
        {
          name: "mpl_token_metadata",
          programId: MPL_TOKEN_METADATA_PROGRAM_ID,
        },
      ],
      cpmmAccounts(),
    );
  }, TEST_TIMEOUT);

  /**
   * Creates an SPL mint owned by ctx.payer and an ATA holding `amount`.
   * bankrun rejects byte-identical transactions, so every send carries a
   * varying CU-limit instruction (CLAUDE.md gotcha).
   */
  async function createFundedMint(
    mint: Keypair,
    decimals: number,
    amount: bigint,
  ): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(
      mint.publicKey,
      ctx.payer.publicKey,
    );
    const rent = Number(
      (await ctx.banksClient.getRent()).minimumBalance(BigInt(MINT_SIZE)),
    );
    await send(
      ctx,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + cuNonce++ }),
        SystemProgram.createAccount({
          fromPubkey: ctx.payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: rent,
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(
          mint.publicKey,
          decimals,
          ctx.payer.publicKey,
          null,
        ),
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          ata,
          ctx.payer.publicKey,
          mint.publicKey,
        ),
        createMintToInstruction(
          mint.publicKey,
          ata,
          ctx.payer.publicKey,
          amount,
        ),
      ],
      [mint],
    );
    return ata;
  }

  /** A wSOL account funded by transfer + sync_native, as migration will do. */
  async function createFundedWsol(lamports: bigint): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(
      NATIVE_MINT,
      ctx.payer.publicKey,
    );
    await send(
      ctx,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 + cuNonce++ }),
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          ata,
          ctx.payer.publicKey,
          NATIVE_MINT,
        ),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: ata,
          lamports: Number(lamports),
        }),
        // syncNative: token program ix 17, no accounts beyond the target.
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [{ pubkey: ata, isSigner: false, isWritable: true }],
          data: Buffer.from([17]),
        }),
      ],
      [],
    );
    return ata;
  }

  it(
    "pins the authority PDA and AmmConfig layout we read at runtime",
    async () => {
      // If this seed were wrong every CPI would fail with an opaque error;
      // deriving it here turns that into a one-line diff.
      const [authority, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_and_lp_mint_auth_seed")],
        RAYDIUM_CPMM_PROGRAM_ID,
      );
      expect(authority.toBase58()).toBe(RAYDIUM_CPMM_AUTHORITY.toBase58());
      expect(bump).toBeGreaterThan(0);

      const config = await ctx.banksClient.getAccount(RAYDIUM_CPMM_AMM_CONFIG);
      expect(config).not.toBeNull();
      const data = Buffer.from(config!.data);
      expect(new PublicKey(config!.owner).toBase58()).toBe(
        RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
      );
      expect(data.length).toBe(236);
      expect([...data.subarray(0, 8)]).toEqual(AMM_CONFIG_DISCRIMINATOR);
      // Byte offsets the migration reads. create_pool_fee is admin-settable,
      // so the program must read it live rather than hardcode 0.15 SOL.
      expect(data[9]).toBe(0); // disable_create_pool — plain init permissionless
      expect(data.readUInt16LE(10)).toBe(0); // index 0 == the 0.25% tier
      expect(data.readBigUInt64LE(12)).toBe(2_500n); // trade_fee_rate
      expect(data.readBigUInt64LE(36)).toBe(BigInt(EXPECTED_CREATE_POOL_FEE));

      // The AmmConfig PDA itself: ["amm_config", u16 index big-endian].
      const indexBytes = Buffer.alloc(2);
      indexBytes.writeUInt16BE(0);
      expect(pda([Buffer.from("amm_config"), indexBytes]).toBase58()).toBe(
        RAYDIUM_CPMM_AMM_CONFIG.toBase58(),
      );

      // The fee receiver is a wSOL token account: initialize transfers
      // lamports to it and calls sync_native, so it must be a native account.
      const receiver = await ctx.banksClient.getAccount(
        RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
      );
      const receiverData = Buffer.from(receiver!.data);
      expect(new PublicKey(receiver!.owner).toBase58()).toBe(
        TOKEN_PROGRAM_ID.toBase58(),
      );
      expect(new PublicKey(receiverData.subarray(0, 32)).toBase58()).toBe(
        NATIVE_MINT.toBase58(),
      );

      // The fixture must come from the deployment we verified — an older
      // dump would prove nothing about today's interface (D-031).
      const slots = JSON.parse(
        readFileSync(join(FIXTURES, "fixture-slots.json"), "utf8"),
      ) as Record<string, { deploySlot: number } | undefined>;
      expect(slots.cpmm?.deploySlot).toBeGreaterThanOrEqual(
        RAYDIUM_CPMM_VERIFIED_SLOT,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "creates a pool at a NON-canonical signing pool_state (the unsquattable path)",
    async () => {
      // Graduation signs its own PDA rather than racing for the canonical
      // one. Here a plain keypair stands in for that PDA — same code path in
      // the program (`key != canonical => require is_signer`).
      const coin = Keypair.generate();
      const amountCoin = 206_900_000_000_000n;
      const amountSol = 84_800_000_000n;
      const coinAta = await createFundedMint(coin, 6, amountCoin);
      const wsolAta = await createFundedWsol(amountSol);

      // token_0 must sort below token_1; WSOL starts with byte 6, so a
      // random coin mint sorts ABOVE it ~97.7% of the time.
      const wsolIsToken0 =
        Buffer.compare(NATIVE_MINT.toBuffer(), coin.publicKey.toBuffer()) < 0;
      const [mint0, mint1] = wsolIsToken0
        ? [NATIVE_MINT, coin.publicKey]
        : [coin.publicKey, NATIVE_MINT];
      const [token0, token1] = wsolIsToken0
        ? [wsolAta, coinAta]
        : [coinAta, wsolAta];
      const [amount0, amount1] = wsolIsToken0
        ? [amountSol, amountCoin]
        : [amountCoin, amountSol];

      const poolKey = Keypair.generate();
      const accounts = derivePoolAccounts(
        poolKey.publicKey,
        mint0,
        mint1,
        ctx.payer.publicKey,
      );

      const feeBefore = await balance(
        ctx,
        RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
      );
      const payerBefore = await balance(ctx, ctx.payer.publicKey);

      await send(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000 + cuNonce++,
          }),
          initializeIx({
            creator: ctx.payer.publicKey,
            mint0,
            mint1,
            creatorToken0: token0,
            creatorToken1: token1,
            accounts,
            amount0,
            amount1,
            openTime: 0n, // program clamps <= now to now + 1
            poolStateIsSigner: true,
          }),
        ],
        [poolKey],
      );

      // Pool exists, owned by CPMM, at the size our rent math assumes.
      const pool = await ctx.banksClient.getAccount(poolKey.publicKey);
      expect(pool).not.toBeNull();
      expect(new PublicKey(pool!.owner).toBase58()).toBe(
        RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
      );
      expect(pool!.data.length).toBe(POOL_STATE_LEN);
      const observation = await ctx.banksClient.getAccount(
        accounts.observation,
      );
      expect(observation!.data.length).toBe(OBSERVATION_STATE_LEN);

      // Liquidity landed in the program's vaults, exactly.
      expect(await tokenAmount(ctx, accounts.vault0)).toBe(amount0);
      expect(await tokenAmount(ctx, accounts.vault1)).toBe(amount1);

      // LP accounting — measured, and NOT what the docs imply. The program
      // computes sqrt(a0*a1) then withholds `lock_lp_amount = 100` by simply
      // NEVER MINTING it: total supply is sqrt-100, all of it the creator's.
      // The withheld 100 is liquidity nobody can ever redeem, not a token
      // balance. Consequence for INV-LP-BURNED: burning the creator balance
      // drives lp_mint.supply to 0 (not 100), which is what migrate asserts.
      const expectedLp = isqrt(amount0 * amount1) - 100n;
      expect(await mintSupply(ctx, accounts.lpMint)).toBe(expectedLp);
      expect(await tokenAmount(ctx, accounts.creatorLp)).toBe(expectedLp);

      // The fee is paid in native lamports and synced into the wSOL account.
      expect(
        (await balance(ctx, RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER)) - feeBefore,
      ).toBe(EXPECTED_CREATE_POOL_FEE);

      // The number the curve must reserve before it can graduate. The wSOL
      // liquidity left the payer as tokens earlier, so the remaining spend is
      // the pool fee, the rent for the six accounts initialize creates, and
      // the signature fee (payer + pool_state keypair, 5000 lamports each).
      const SIGNATURE_FEE = 5_000 * 2;
      const spent =
        payerBefore -
        (await balance(ctx, ctx.payer.publicKey)) -
        SIGNATURE_FEE;
      expect(spent).toBe(EXPECTED_CREATE_POOL_FEE + EXPECTED_RENT_TOTAL);
      // Pinned: the migration reserve the curve carries (SPEC-LAUNCHPAD A1).
      expect(spent).toBe(192_156_720);
    },
    TEST_TIMEOUT,
  );

  it(
    "creates a pool at the canonical PDA without a pool_state signature",
    async () => {
      const coin = Keypair.generate();
      const amountCoin = 1_000_000_000_000n;
      const amountSol = 1_000_000_000n;
      const coinAta = await createFundedMint(coin, 6, amountCoin);
      const wsolAta = await createFundedWsol(amountSol);

      const wsolIsToken0 =
        Buffer.compare(NATIVE_MINT.toBuffer(), coin.publicKey.toBuffer()) < 0;
      const [mint0, mint1] = wsolIsToken0
        ? [NATIVE_MINT, coin.publicKey]
        : [coin.publicKey, NATIVE_MINT];
      const [token0, token1] = wsolIsToken0
        ? [wsolAta, coinAta]
        : [coinAta, wsolAta];
      const [amount0, amount1] = wsolIsToken0
        ? [amountSol, amountCoin]
        : [amountCoin, amountSol];

      const canonical = pda([
        Buffer.from("pool"),
        RAYDIUM_CPMM_AMM_CONFIG.toBuffer(),
        mint0.toBuffer(),
        mint1.toBuffer(),
      ]);
      const accounts = derivePoolAccounts(
        canonical,
        mint0,
        mint1,
        ctx.payer.publicKey,
      );

      await send(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000 + cuNonce++,
          }),
          initializeIx({
            creator: ctx.payer.publicKey,
            mint0,
            mint1,
            creatorToken0: token0,
            creatorToken1: token1,
            accounts,
            amount0,
            amount1,
            openTime: 0n,
            poolStateIsSigner: false,
          }),
        ],
        [],
      );

      const pool = await ctx.banksClient.getAccount(canonical);
      expect(pool).not.toBeNull();
      expect(pool!.data.length).toBe(POOL_STATE_LEN);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses a non-canonical pool_state that does not sign",
    async () => {
      // This is the constraint that makes A8 safe: an attacker cannot hand
      // the program someone else's address as the pool.
      const coin = Keypair.generate();
      const coinAta = await createFundedMint(coin, 6, 1_000_000_000_000n);
      const wsolAta = await createFundedWsol(1_000_000_000n);

      const wsolIsToken0 =
        Buffer.compare(NATIVE_MINT.toBuffer(), coin.publicKey.toBuffer()) < 0;
      const [mint0, mint1] = wsolIsToken0
        ? [NATIVE_MINT, coin.publicKey]
        : [coin.publicKey, NATIVE_MINT];
      const [token0, token1] = wsolIsToken0
        ? [wsolAta, coinAta]
        : [coinAta, wsolAta];

      const accounts = derivePoolAccounts(
        Keypair.generate().publicKey,
        mint0,
        mint1,
        ctx.payer.publicKey,
      );

      const logs = await sendExpectFail(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000 + cuNonce++,
          }),
          initializeIx({
            creator: ctx.payer.publicKey,
            mint0,
            mint1,
            creatorToken0: token0,
            creatorToken1: token1,
            accounts,
            amount0: 1_000_000n,
            amount1: 1_000_000n,
            openTime: 0n,
            poolStateIsSigner: false,
          }),
        ],
        [],
      );
      expect(logs).toMatch(/signer|Signer|custom program error|failed/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses mints supplied in the wrong sort order",
    async () => {
      // Migration must branch on the byte comparison; passing the pair the
      // wrong way round has to fail loudly rather than build a mirrored pool.
      const coin = Keypair.generate();
      const coinAta = await createFundedMint(coin, 6, 1_000_000_000_000n);
      const wsolAta = await createFundedWsol(1_000_000_000n);

      const wsolIsToken0 =
        Buffer.compare(NATIVE_MINT.toBuffer(), coin.publicKey.toBuffer()) < 0;
      // Deliberately inverted relative to the required ordering.
      const [mint0, mint1] = wsolIsToken0
        ? [coin.publicKey, NATIVE_MINT]
        : [NATIVE_MINT, coin.publicKey];
      const [token0, token1] = wsolIsToken0
        ? [coinAta, wsolAta]
        : [wsolAta, coinAta];

      const poolKey = Keypair.generate();
      const accounts = derivePoolAccounts(
        poolKey.publicKey,
        mint0,
        mint1,
        ctx.payer.publicKey,
      );

      const logs = await sendExpectFail(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 400_000 + cuNonce++,
          }),
          initializeIx({
            creator: ctx.payer.publicKey,
            mint0,
            mint1,
            creatorToken0: token0,
            creatorToken1: token1,
            accounts,
            amount0: 1_000_000n,
            amount1: 1_000_000n,
            openTime: 0n,
            poolStateIsSigner: true,
          }),
        ],
        [poolKey],
      );
      expect(logs).toMatch(/constraint|custom program error|failed/i);
    },
    TEST_TIMEOUT,
  );
});
