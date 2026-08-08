/**
 * GATE L1 leg 2 — the launchpad lifecycle, end to end on real binaries
 * (SPEC-LAUNCHPAD.md §2/§3).
 *
 * A coin is created, traded by several wallets, driven to completion, and
 * graduated into a REAL Raydium CPMM pool with the LP burned — against the
 * mainnet CPMM and Metaplex binaries in bankrun, with exact balance
 * assertions at every step. The DAO leg then repeats the money path with a
 * PDA as the coin's creator, which is the whole point of INV-CREATOR-ARG.
 *
 * Both mint orderings are exercised: wSOL's first byte is 6, so a coin mint
 * sorts above it ~97.7% of the time and the wSOL-as-token_1 branch is the
 * one that goes untested in the wild.
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
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { ProgramTestContext } from "solana-bankrun";
import {
  PUMP_CLASSIC,
  applyBuy,
  buyQuote,
  initialState,
  raiseAtCompletion,
  sellQuote,
  type CurveState,
} from "../packages/sdk/src/curve-math";
import {
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  TEST_TIMEOUT,
  balance,
  send,
  sendExpectFail,
} from "./helpers/bankrun-harness";
import {
  buyIx,
  collectCreatorFeeIx,
  cpmmPoolAccounts,
  createCoinIx,
  creatorVaultPda,
  curvePda,
  grindMint,
  initializeConfigIx,
  migrateIx,
  migrationAuthorityPda,
  mintAuthorities,
  mintSupply,
  readCurve,
  sellIx,
  solVaultPda,
  startLaunchpadCtx,
  tokenBalance,
} from "./helpers/launchpad-harness";

const CPMM_RENT_LAMPORTS = 42_156_720n;
const CREATE_POOL_FEE = 150_000_000n;
const MIGRATION_OVERHEAD = CREATE_POOL_FEE + CPMM_RENT_LAMPORTS;

describe("launchpad-curve — lifecycle on real binaries", () => {
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
    // Fee destinations must sit at the rent floor before they can receive
    // sub-floor fee crumbs (D-009).
    await fund(feeRecipient.publicKey, 890_880);
  }, TEST_TIMEOUT);

  it(
    "creates a coin with its supply escrowed and both authorities already gone",
    async () => {
      const mint = grindMint(false);
      const creator = Keypair.generate();
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

      const curve = await readCurve(ctx, mint.publicKey);
      expect(curve.mint.toBase58()).toBe(mint.publicKey.toBase58());
      // INV-CREATOR-ARG: the creator never signed this transaction.
      expect(curve.creator.toBase58()).toBe(creator.publicKey.toBase58());
      expect(curve.virtualSol).toBe(PUMP_CLASSIC.initialVirtualSol);
      expect(curve.virtualToken).toBe(PUMP_CLASSIC.initialVirtualToken);
      expect(curve.realSol).toBe(0n);
      expect(curve.realToken).toBe(PUMP_CLASSIC.initialRealToken);
      expect(curve.protocolFeeBps).toBe(PUMP_CLASSIC.protocolFeeBps);
      expect(curve.creatorFeeBps).toBe(PUMP_CLASSIC.creatorFeeBps);
      expect(curve.complete).toBe(false);
      expect(curve.migrated).toBe(false);

      // The entire supply sits in the curve's vault — no premine, no
      // allocation, the only way to hold this coin is to buy it.
      expect(await mintSupply(ctx, mint.publicKey)).toBe(
        PUMP_CLASSIC.tokenTotalSupply,
      );
      const vault = getAssociatedTokenAddressSync(
        mint.publicKey,
        curvePda(mint.publicKey),
        true,
      );
      expect(await tokenBalance(ctx, vault)).toBe(PUMP_CLASSIC.tokenTotalSupply);

      // Nobody can mint more, and nobody can freeze a holder.
      expect(await mintAuthorities(ctx, mint.publicKey)).toEqual({
        mintAuthority: false,
        freezeAuthority: false,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "prices buys and sells exactly as the TypeScript reference does",
    async () => {
      const mint = grindMint(false);
      const creator = Keypair.generate();
      const trader = Keypair.generate();
      await fund(trader.publicKey, 40_000_000_000);
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

      let model: CurveState = initialState(PUMP_CLASSIC);
      const traderAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        trader.publicKey,
        true,
      );

      // The raise lives in the system-owned sol vault, NOT the curve account.
      // Capture the vault's rent floor (its balance when realSol is still 0)
      // and the curve account's own rent, then assert after every trade that
      // the vault holds exactly rentFloor + realSol and the curve account
      // never accumulates a lamport of the raise (INV-SOL-CONSERVATION, and
      // the whole point of the sol-vault redesign).
      const solVault = solVaultPda(mint.publicKey);
      const solVaultFloor = BigInt(await balance(ctx, solVault));
      const curveAccountRent = BigInt(await balance(ctx, curvePda(mint.publicKey)));

      // A few buys of different sizes, each checked against the model to
      // the lamport before moving on.
      for (const amount of [
        1_000_000_000_000n,
        37_500_000_000_000n,
        250_000_000n,
      ]) {
        const quote = buyQuote(model, amount);
        const before = {
          trader: await balance(ctx, trader.publicKey),
          fee: await balance(ctx, feeRecipient.publicKey),
          creatorVault: await balance(ctx, creatorVaultPda(creator.publicKey)),
          tokens: await tokenBalance(ctx, traderAta),
        };

        await send(
          ctx,
          [
            cu(),
            buyIx({
              user: trader.publicKey,
              mint: mint.publicKey,
              creator: creator.publicKey,
              feeRecipient: feeRecipient.publicKey,
              tokenAmount: amount,
              maxSolCost: quote.totalCost,
            }),
          ],
          [trader],
        );
        model = applyBuy(model, quote);

        // Fees land where they are supposed to, exactly.
        expect(
          BigInt((await balance(ctx, feeRecipient.publicKey)) - before.fee),
        ).toBe(quote.protocolFee);
        expect(
          BigInt(
            (await balance(ctx, creatorVaultPda(creator.publicKey))) -
              before.creatorVault,
          ),
        ).toBe(quote.creatorFee);
        expect((await tokenBalance(ctx, traderAta)) - before.tokens).toBe(
          quote.tokensOut,
        );

        // INV-SOL-CONSERVATION and full state parity with the model.
        const onChain = await readCurve(ctx, mint.publicKey);
        expect(onChain.virtualSol).toBe(model.virtualSol);
        expect(onChain.virtualToken).toBe(model.virtualToken);
        expect(onChain.realSol).toBe(model.realSol);
        expect(onChain.realToken).toBe(model.realToken);
        // The physical lamports back the accounting number, and they sit in
        // the sol vault — the curve account is untouched by the raise.
        expect(BigInt(await balance(ctx, solVault))).toBe(
          solVaultFloor + model.realSol,
        );
        expect(BigInt(await balance(ctx, curvePda(mint.publicKey)))).toBe(
          curveAccountRent,
        );
      }

      // ...then sell part of it back.
      const sellAmount = 500_000_000_000n;
      const sQuote = sellQuote(model, sellAmount);
      const traderBefore = await balance(ctx, trader.publicKey);
      await send(
        ctx,
        [
          cu(),
          sellIx({
            user: trader.publicKey,
            mint: mint.publicKey,
            creator: creator.publicKey,
            feeRecipient: feeRecipient.publicKey,
            tokenAmount: sellAmount,
            minSolOutput: sQuote.netSol,
          }),
        ],
        [trader],
      );
      // The seller receives exactly net (the harness's payer, not the
      // trader, carries the transaction fee).
      expect(
        BigInt((await balance(ctx, trader.publicKey)) - traderBefore),
      ).toBe(sQuote.netSol);

      const after = await readCurve(ctx, mint.publicKey);
      expect(after.realSol).toBe(model.realSol - sQuote.grossSol);
      expect(after.realToken).toBe(model.realToken + sellAmount);
      // Proceeds came out of the sol vault; it still holds exactly the raise.
      expect(BigInt(await balance(ctx, solVault))).toBe(
        solVaultFloor + (model.realSol - sQuote.grossSol),
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses a buy whose cost exceeds the caller's slippage cap",
    async () => {
      const mint = grindMint(false);
      const creator = Keypair.generate();
      const trader = Keypair.generate();
      await fund(trader.publicKey, 5_000_000_000);
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

      const quote = buyQuote(initialState(PUMP_CLASSIC), 1_000_000_000_000n);
      const logs = await sendExpectFail(
        ctx,
        [
          cu(),
          buyIx({
            user: trader.publicKey,
            mint: mint.publicKey,
            creator: creator.publicKey,
            feeRecipient: feeRecipient.publicKey,
            tokenAmount: 1_000_000_000_000n,
            maxSolCost: quote.totalCost - 1n,
          }),
        ],
        [trader],
      );
      expect(logs).toMatch(/slippage/i);
    },
    TEST_TIMEOUT,
  );

  /**
   * The whole point of the subsystem: a curve completes and its liquidity
   * ends up in a real Raydium pool that nobody — including us — can pull.
   * Run for both mint orderings.
   */
  for (const belowWsol of [false, true]) {
    // Graduation, proven end to end. The raise moves through the system-owned
    // `["sol-vault", mint]` PDA (SPEC-LAUNCHPAD §2.1): every SOL leg is a
    // signed system_program::transfer, so the "sum of account balances ...
    // do not match" rejection that once blocked this is gone by construction.
    // The CPMM side is independently verified in
    // tests/launchpad-cpmm-verify.integration.test.ts (pool creation, LP
    // accounting, the 192,156,720-lamport cost, both mint orderings).
    it(
      `completes and graduates a coin whose mint sorts ${belowWsol ? "below" : "above"} wSOL`,
      async () => {
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

        // One buy for the whole reserve: the curve completes and freezes.
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

        const completed = await readCurve(ctx, mint.publicKey);
        expect(completed.complete).toBe(true);
        expect(completed.realToken).toBe(0n);
        expect(completed.realSol).toBe(raiseAtCompletion(PUMP_CLASSIC));

        // INV-COMPLETE-MONOTONE: trading is closed, both directions.
        expect(
          await sendExpectFail(
            ctx,
            [
              cu(),
              buyIx({
                user: whale.publicKey,
                mint: mint.publicKey,
                creator: creator.publicKey,
                feeRecipient: feeRecipient.publicKey,
                tokenAmount: 1n,
                maxSolCost: 1_000_000_000n,
              }),
            ],
            [whale],
          ),
        ).toMatch(/complete/i);

        // Migration is cranked by a wallet with no relationship to the coin
        // — permissionless is the property, not a convenience.
        const stranger = Keypair.generate();
        await fund(stranger.publicKey, 1_000_000_000);

        const pool = cpmmPoolAccounts(mint.publicKey);
        const feeBefore = await balance(ctx, RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER);
        const poolSol = completed.realSol - MIGRATION_OVERHEAD;

        await send(
          ctx,
          [
            ComputeBudgetProgram.setComputeUnitLimit({
              units: 1_400_000 + cuNonce++,
            }),
            migrateIx({
              payer: stranger.publicKey,
              mint: mint.publicKey,
              feeRecipient: feeRecipient.publicKey,
            }),
          ],
          [stranger],
        );

        // A real Raydium pool now exists at our PDA.
        const poolAccount = await ctx.banksClient.getAccount(pool.poolState);
        expect(poolAccount).not.toBeNull();
        expect(new PublicKey(poolAccount!.owner).toBase58()).toBe(
          RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
        );

        // Seeded with everything the curve held, to the lamport and token.
        const wsolVault = pool.wsolIsToken0 ? pool.vault0 : pool.vault1;
        const coinVault = pool.wsolIsToken0 ? pool.vault1 : pool.vault0;
        expect(await tokenBalance(ctx, wsolVault)).toBe(poolSol);
        expect(await tokenBalance(ctx, coinVault)).toBe(
          PUMP_CLASSIC.tokenTotalSupply - PUMP_CLASSIC.initialRealToken,
        );
        expect(
          BigInt(
            (await balance(ctx, RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER)) - feeBefore,
          ),
        ).toBe(CREATE_POOL_FEE);

        // INV-LP-BURNED. Raydium never mints the 100 units it withholds, so
        // a fully burned pool reads zero — measured, not assumed (D-034).
        expect(await mintSupply(ctx, pool.lpMint)).toBe(0n);
        expect(await tokenBalance(ctx, pool.migrationLp)).toBe(0n);

        // Nothing is left behind in the migration accounts.
        const migration = migrationAuthorityPda(mint.publicKey);
        expect(await balance(ctx, migration)).toBe(0);
        expect(
          await ctx.banksClient.getAccount(
            getAssociatedTokenAddressSync(NATIVE_MINT, migration, true),
          ),
        ).toBeNull();

        const migrated = await readCurve(ctx, mint.publicKey);
        expect(migrated.migrated).toBe(true);
        expect(migrated.realSol).toBe(0n);
        expect(migrated.poolState.toBase58()).toBe(pool.poolState.toBase58());

        // Idempotent by refusal: a second crank cannot double-spend.
        expect(
          await sendExpectFail(
            ctx,
            [
              ComputeBudgetProgram.setComputeUnitLimit({
                units: 1_400_000 + cuNonce++,
              }),
              migrateIx({
                payer: stranger.publicKey,
                mint: mint.publicKey,
                feeRecipient: feeRecipient.publicKey,
              }),
            ],
            [stranger],
          ),
        ).toMatch(/already migrated|already in use/i);
      },
      TEST_TIMEOUT,
    );
  }

  it(
    "pays creator fees to a PDA creator, swept by a stranger (the DAO path)",
    async () => {
      // A Squads vault PDA cannot sign anything, which is exactly why
      // pump.fun's creator-must-sign collection failed GATE 0c. Here the
      // creator is an off-curve PDA-shaped address and a random wallet
      // cranks the sweep; the funds can only go one place.
      const mint = grindMint(false);
      const daoVault = PublicKey.findProgramAddressSync(
        [Buffer.from("fake-dao-vault")],
        RAYDIUM_CPMM_PROGRAM_ID,
      )[0];
      const trader = Keypair.generate();
      const cranker = Keypair.generate();
      await fund(trader.publicKey, 20_000_000_000);
      await fund(cranker.publicKey, 1_000_000_000);
      await fund(daoVault, 890_880);

      await send(
        ctx,
        [
          cu(),
          createCoinIx({
            payer: ctx.payer.publicKey,
            mint: mint.publicKey,
            creator: daoVault,
          }),
        ],
        [mint],
      );

      const amount = 5_000_000_000_000n;
      const quote = buyQuote(initialState(PUMP_CLASSIC), amount);
      await send(
        ctx,
        [
          cu(),
          buyIx({
            user: trader.publicKey,
            mint: mint.publicKey,
            creator: daoVault,
            feeRecipient: feeRecipient.publicKey,
            tokenAmount: amount,
            maxSolCost: quote.totalCost,
          }),
        ],
        [trader],
      );

      // create_coin seeds the vault to the rent floor so the first fee
      // crumb has somewhere to land; the fee accrues on top of it.
      const rentFloor = 890_880;
      const vault = creatorVaultPda(daoVault);
      expect(BigInt(await balance(ctx, vault))).toBe(
        quote.creatorFee + BigInt(rentFloor),
      );

      const daoBefore = await balance(ctx, daoVault);
      await send(
        ctx,
        [
          cu(),
          collectCreatorFeeIx({
            payer: cranker.publicKey,
            creator: daoVault,
            mint: mint.publicKey,
          }),
        ],
        [cranker],
      );

      // Everything above the vault's rent floor reached the DAO, and the
      // floor stays behind so the vault survives for the next trade.
      expect(await balance(ctx, daoVault)).toBe(
        daoBefore + Number(quote.creatorFee),
      );
      expect(await balance(ctx, vault)).toBe(rentFloor);

      // And the sweep pays the recorded creator, nobody else.
      const thief = Keypair.generate();
      const logs = await sendExpectFail(
        ctx,
        [
          cu(),
          {
            ...collectCreatorFeeIx({
              payer: cranker.publicKey,
              creator: daoVault,
              mint: mint.publicKey,
            }),
            keys: collectCreatorFeeIx({
              payer: cranker.publicKey,
              creator: daoVault,
              mint: mint.publicKey,
            }).keys.map((k, i) =>
              i === 1 ? { ...k, pubkey: thief.publicKey } : k,
            ),
          },
        ],
        [cranker],
      );
      expect(logs).toMatch(/unauthorized|constraint|custom program error/i);
    },
    TEST_TIMEOUT,
  );
});
