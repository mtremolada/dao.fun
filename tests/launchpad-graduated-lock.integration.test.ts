/**
 * The whole point of the feature, end to end on REAL binaries: a coin is
 * created on our curve, bought to completion, graduated into a Raydium CPMM
 * pool, and its LP handed to Raydium's Burn & Earn locker — after which the
 * pool's trading fees are collectable forever by a PDA that can only pay the
 * coin's creator.
 *
 * G0 (launchpad-lock-verify) proved the locker's interface in isolation.
 * This proves OUR program drives it, which is a different claim: the CPI
 * account order, the PDA signer set (protocol vault pays, migration
 * authority owns the LP, fee-key mint is a PDA), and the config gate that
 * keeps devnet on the burn branch.
 *
 * Fixture rebuild: see tests/helpers/launchpad-harness.ts.
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
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_LOCK_CP_AUTHORITY,
  RAYDIUM_LOCK_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  buildCollectGraduatedFeesIx,
  buildCpmmSwapBaseInputIx,
  decodeCpmmPool,
  buildLockGraduatedLiquidityIx,
  buildSetGraduationConfigIx,
  feeAuthorityPda,
  feeNftMintPda,
  graduatedFeesPda,
  lockCpAuthorityPda,
  lockedLiquidityPda,
  protocolVaultPda,
  raydiumCpmmAddresses,
} from "../packages/sdk/src/launchpad";
import {
  TEST_TIMEOUT,
  balance,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";
import {
  buyIx,
  cpmmFixtureAccounts,
  cpmmPoolAccounts,
  createCoinIx,
  grindMint,
  initializeConfigIx,
  migrateIx,
  readCurve,
  tokenBalance,
} from "./helpers/launchpad-harness";
import { LAUNCHPAD_PROGRAM_ID } from "../packages/sdk/src/launchpad";

const RAY = raydiumCpmmAddresses("mainnet");

describe("graduated liquidity — our program drives Raydium's locker", () => {
  let ctx: ProgramTestContext;
  const authority = Keypair.generate();
  const feeRecipient = Keypair.generate();
  let cuNonce = 0;
  const cu = (units = 400_000) =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: units + cuNonce++ });

  beforeAll(async () => {
    // Same context as the curve suites PLUS the real locker binary.
    ctx = await startCtx(
      [
        { name: "launchpad_curve", programId: LAUNCHPAD_PROGRAM_ID },
        { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
        { name: "raydium_lock", programId: RAYDIUM_LOCK_PROGRAM_ID },
        { name: "mpl_token_metadata", programId: MPL_TOKEN_METADATA_PROGRAM_ID },
      ],
      cpmmFixtureAccounts(),
    );
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
    await send(
      ctx,
      [
        cu(),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: feeRecipient.publicKey,
          lamports: 890_880,
        }),
      ],
      [],
    );
  }, TEST_TIMEOUT);

  /** Trades both ways so the locked position accrues real fees. */
  async function tradeForFees(mint: PublicKey, rounds = 2, perRound = 10_000_000_000) {
    const trader = Keypair.generate();
    const pool = cpmmPoolAccounts(mint).poolState;
    await send(
      ctx,
      [
        cu(),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: trader.publicKey,
          lamports: 60_000_000_000,
        }),
      ],
      [],
    );
    const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, trader.publicKey);
    const coinAta = getAssociatedTokenAddressSync(mint, trader.publicKey);
    await send(
      ctx,
      [
        cu(),
        createAssociatedTokenAccountIdempotentInstruction(
          trader.publicKey, wsolAta, trader.publicKey, NATIVE_MINT),
        createAssociatedTokenAccountIdempotentInstruction(
          trader.publicKey, coinAta, trader.publicKey, mint),
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
            lamports: perRound,
          }),
          createSyncNativeInstruction(wsolAta),
        ],
        [trader],
      );
      for (const [inMint, from, to] of [
        [NATIVE_MINT, wsolAta, coinAta],
        [mint, coinAta, wsolAta],
      ] as const) {
        const info = await ctx.banksClient.getAccount(pool);
        const amountIn = await tokenBalance(ctx, from);
        await send(
          ctx,
          [
            cu(),
            buildCpmmSwapBaseInputIx({
              payer: trader.publicKey,
              cpmmProgram: RAYDIUM_CPMM_PROGRAM_ID,
              poolState: pool,
              pool: decodeCpmmPool(Buffer.from(info!.data)),
              inputMint: inMint,
              inputTokenAccount: from,
              outputTokenAccount: to,
              amountIn,
              minimumAmountOut: 0n,
            }),
          ],
          [trader],
        );
      }
    }
  }

  /** create -> whale buys out -> migrate. */
  async function graduate(): Promise<{ mint: Keypair; creator: PublicKey }> {
    const mint = grindMint(false);
    const creator = Keypair.generate();
    const whale = Keypair.generate();
    await send(
      ctx,
      [
        cu(),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: whale.publicKey,
          lamports: 120_000_000_000,
        }),
      ],
      [],
    );
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
          tokenAmount: PUMP_CLASSIC.initialRealToken,
          maxSolCost: 120_000_000_000n,
        }),
      ],
      [whale],
    );
    await send(
      ctx,
      [
        cu(1_400_000),
        migrateIx({
          payer: ctx.payer.publicKey,
          mint: mint.publicKey,
          feeRecipient: feeRecipient.publicKey,
        }),
      ],
      [],
    );
    await warpSeconds(ctx, 2);
    return { mint, creator: creator.publicKey };
  }

  const enableLocking = () =>
    send(
      ctx,
      [
        cu(),
        buildSetGraduationConfigIx({
          authority: authority.publicKey,
          ammConfig: RAY.ammConfig,
          lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
          graduatedFeeProtocolBps: 2_000,
        }),
      ],
      [authority],
    );

  const disableLocking = () =>
    send(
      ctx,
      [
        cu(),
        buildSetGraduationConfigIx({
          authority: authority.publicKey,
          ammConfig: RAY.ammConfig,
          lockProgram: PublicKey.default,
          graduatedFeeProtocolBps: 0,
        }),
      ],
      [authority],
    );

  it(
    "burns the LP when no locker is configured — devnet's only branch",
    async () => {
      await disableLocking();
      const { mint } = await graduate();
      const derived = cpmmPoolAccounts(mint.publicKey);
      // Raydium never mints the 100 units it withholds, so a fully burned
      // pool reads supply 0.
      const supply = (await ctx.banksClient.getAccount(derived.lpMint))!.data;
      expect(Buffer.from(supply).readBigUInt64LE(36)).toBe(0n);
      // ...and there is no graduated-fee record, so nothing new exists on
      // the cluster that cannot support it.
      expect(
        await ctx.banksClient.getAccount(graduatedFeesPda(mint.publicKey)),
      ).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses to lock while the config says burn",
    async () => {
      await disableLocking();
      const { mint } = await graduate();
      const logs = await sendExpectFail(
        ctx,
        [
          cu(600_000),
          buildLockGraduatedLiquidityIx({
            payer: ctx.payer.publicKey,
            mint: mint.publicKey,
            poolState: cpmmPoolAccounts(mint.publicKey).poolState,
            lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
            ray: RAY,
          }),
        ],
        [],
      );
      expect(logs).toMatch(/LockingDisabled|not configured|custom program error/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "locks the LP to a fee key our PDA owns, paid by the coin's own fees",
    async () => {
      await enableLocking();
      const { mint } = await graduate();
      const derived = cpmmPoolAccounts(mint.publicKey);

      // migrate kept the LP instead of burning it.
      const lpHeld = await tokenBalance(ctx, derived.migrationLp);
      expect(lpHeld > 0n).toBe(true);

      // The cranker is a stranger and pays nothing but the signature.
      const cranker = Keypair.generate();
      await send(
        ctx,
        [
          cu(),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: cranker.publicKey,
            lamports: 100_000_000,
          }),
        ],
        [],
      );
      const crankerBefore = await balance(ctx, cranker.publicKey);
      const vaultBefore = await balance(ctx, protocolVaultPda(mint.publicKey));

      await send(
        ctx,
        [
          cu(600_000),
          buildLockGraduatedLiquidityIx({
            payer: cranker.publicKey,
            mint: mint.publicKey,
            poolState: derived.poolState,
            lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
            ray: RAY,
          }),
        ],
        [cranker],
        cranker,
      );

      // The LP left us for the locker's vault, irreversibly.
      expect(await tokenBalance(ctx, derived.migrationLp)).toBe(0n);
      const lockedVault = getAssociatedTokenAddressSync(
        derived.lpMint,
        RAYDIUM_LOCK_CP_AUTHORITY,
        true,
      );
      expect(await tokenBalance(ctx, lockedVault)).toBe(lpHeld);
      expect(lockCpAuthorityPda(RAYDIUM_LOCK_PROGRAM_ID).toBase58()).toBe(
        RAYDIUM_LOCK_CP_AUTHORITY.toBase58(),
      );

      // The fee key exists, is a PDA-derived mint (no keypair ever signed
      // for it), and is held by the fee authority — which can only pay the
      // coin's creator.
      const feeNft = feeNftMintPda(mint.publicKey);
      const feeAuthority = feeAuthorityPda(mint.publicKey);
      expect(PublicKey.isOnCurve(feeNft.toBytes())).toBe(false);
      expect(PublicKey.isOnCurve(feeAuthority.toBytes())).toBe(false);
      expect(
        await tokenBalance(ctx, getAssociatedTokenAddressSync(feeNft, feeAuthority, true)),
      ).toBe(1n);
      expect(
        await ctx.banksClient.getAccount(
          lockedLiquidityPda(feeNft, RAYDIUM_LOCK_PROGRAM_ID),
        ),
      ).not.toBeNull();

      // The coin's own protocol fees paid for it; the cranker did not.
      const vaultAfter = await balance(ctx, protocolVaultPda(mint.publicKey));
      const spentByVault = vaultBefore - vaultAfter;
      // 23,328,400 for the locker (G0) + 1,510,320 rent for our record,
      // which the vault reimburses to the cranker.
      expect(spentByVault).toBe(23_328_400 + 1_510_320);
      // The cranker is out exactly one signature. That is what makes
      // "permissionless" true rather than "permissioned by who will donate".
      expect(crankerBefore - (await balance(ctx, cranker.publicKey))).toBe(5_000);

      // ...and the record says exactly that, so the fee stream knows how
      // much to repay before it starts splitting.
      const rec = (await ctx.banksClient.getAccount(
        graduatedFeesPda(mint.publicKey),
      ))!;
      const d = Buffer.from(rec.data);
      expect(new PublicKey(d.subarray(8, 40)).toBase58()).toBe(
        mint.publicKey.toBase58(),
      );
      expect(new PublicKey(d.subarray(40, 72)).toBase58()).toBe(feeNft.toBase58());
      expect(d.readBigUInt64LE(72)).toBe(BigInt(spentByVault));
      expect(d.readBigUInt64LE(80)).toBe(0n);

      // Cranking twice is refused — the record already exists.
      const again = await sendExpectFail(
        ctx,
        [
          cu(600_000),
          buildLockGraduatedLiquidityIx({
            payer: ctx.payer.publicKey,
            mint: mint.publicKey,
            poolState: derived.poolState,
            lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
            ray: RAY,
          }),
        ],
        [],
      );
      expect(again).toMatch(/already in use|custom program error|0x0/i);

      const curve = await readCurve(ctx, mint.publicKey);
      expect(curve.migrated).toBe(true);
    },
    TEST_TIMEOUT,
  );

  it(
    "pays the coin side 100% to the creator, and the SOL side repays the graduation before splitting",
    async () => {
      await enableLocking(); // 2000 bps = 20% of the SOL side, after recovery
      const { mint, creator } = await graduate();
      const derived = cpmmPoolAccounts(mint.publicKey);
      await send(
        ctx,
        [
          cu(600_000),
          buildLockGraduatedLiquidityIx({
            payer: ctx.payer.publicKey,
            mint: mint.publicKey,
            poolState: derived.poolState,
            lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
            ray: RAY,
          }),
        ],
        [],
      );
      const cost = Buffer.from(
        (await ctx.banksClient.getAccount(graduatedFeesPda(mint.publicKey)))!.data,
      ).readBigUInt64LE(72);

      // Real trading, so every lamport below is real k-growth.
      const feeAuthority = feeAuthorityPda(mint.publicKey);
      const ata = (m: PublicKey, o: PublicKey) =>
        getAssociatedTokenAddressSync(m, o, true);
      const creatorCoin = ata(mint.publicKey, creator);
      const creatorSol = ata(NATIVE_MINT, creator);
      const protocolSol = ata(NATIVE_MINT, feeRecipient.publicKey);
      const holding = ata(NATIVE_MINT, feeAuthority);
      await send(
        ctx,
        [
          cu(),
          ...[
            [mint.publicKey, creator, creatorCoin],
            [NATIVE_MINT, creator, creatorSol],
            [NATIVE_MINT, feeRecipient.publicKey, protocolSol],
            [NATIVE_MINT, feeAuthority, holding],
          ].map(([m, owner, addr]) =>
            createAssociatedTokenAccountIdempotentInstruction(
              ctx.payer.publicKey,
              addr as PublicKey,
              owner as PublicKey,
              m as PublicKey,
            ),
          ),
        ],
        [],
      );

      const collect = () =>
        send(
          ctx,
          [
            cu(600_000),
            buildCollectGraduatedFeesIx({
              payer: ctx.payer.publicKey,
              mint: mint.publicKey,
              creator,
              feeRecipient: feeRecipient.publicKey,
              poolState: derived.poolState,
              lockProgram: RAYDIUM_LOCK_PROGRAM_ID,
              ray: RAY,
            }),
          ],
          [],
        );
      const recovered = async () =>
        Buffer.from(
          (await ctx.banksClient.getAccount(graduatedFeesPda(mint.publicKey)))!.data,
        ).readBigUInt64LE(80);

      // --- Phase 1: a small round, deliberately less than the 0.0248 SOL
      // graduation debt, so the recovery path runs on its own.
      await tradeForFees(mint.publicKey, 1, 1_000_000_000);
      await collect();

      // The coin side is the creator's in full — the protocol never touches
      // memecoin dust it could not sell without moving the price.
      expect(await tokenBalance(ctx, creatorCoin)).toBeGreaterThan(0n);

      const rec1 = await recovered();
      expect(rec1 > 0n).toBe(true);
      expect(rec1 < cost).toBe(true);
      // Every lamport of the SOL side went to the debt; the creator sees
      // none of it yet, and nothing is stranded in the holding account.
      expect(await tokenBalance(ctx, protocolSol)).toBe(rec1);
      expect(await tokenBalance(ctx, creatorSol)).toBe(0n);
      expect(await tokenBalance(ctx, holding)).toBe(0n);

      // --- Phase 2: trade until the debt clears. It repays exactly, never
      // more, however much volume arrives in the round that finishes it.
      for (let i = 0; i < 12 && (await recovered()) < cost; i += 1) {
        await tradeForFees(mint.publicKey, 2);
        await collect();
      }
      expect(await recovered()).toBe(cost);

      // --- Phase 3: with the debt gone, the steady-state split applies.
      const protocolBefore = await tokenBalance(ctx, protocolSol);
      const creatorBefore = await tokenBalance(ctx, creatorSol);
      await tradeForFees(mint.publicKey, 2);
      await collect();
      const protocolGain = (await tokenBalance(ctx, protocolSol)) - protocolBefore;
      const creatorGain = (await tokenBalance(ctx, creatorSol)) - creatorBefore;
      expect(creatorGain > 0n).toBe(true);

      // 20% of the SOL side to the protocol, 80% to the creator — to the
      // lamport, with floor rounding favouring the creator.
      const round = protocolGain + creatorGain;
      expect(protocolGain).toBe((round * 2_000n) / 10_000n);
      expect(await tokenBalance(ctx, holding)).toBe(0n);
      // Recovery does not restart once repaid.
      expect(await recovered()).toBe(cost);
    },
    TEST_TIMEOUT,
  );
});
