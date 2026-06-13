/**
 * 13.6b post-graduation actions — graduation + the PumpSwap pool venue,
 * against the REAL pump + pump_amm + governance + Squads binaries (D-021,
 * D-022):
 *
 *   1. The DAO's token graduates: a whale buys out the curve (complete =
 *      true) and ANYONE migrates it (migrate_v2's only signer is `user`);
 *      the canonical PumpSwap pool inherits coinCreator == vault, so the
 *      DAO's creator-fee stream survives graduation (INV-1 continuity).
 *   2. buyback (AMM venue, staged two-leg per D-022): the DAO votes ONE
 *      proposal whose custody-chain leg stages vault SOL to the native
 *      treasury and whose direct legs buy from the pool and return the
 *      bought tokens to the vault's ATA. The buy's creator fee lands in
 *      the DAO's own AMM creator-vault WSOL ATA.
 *   3. provideLiquidity (same staging): SOL + the vault's tokens go in,
 *      the LP tokens come back to the vault.
 *   4. keeper sweep (spec 6.5, both venues): the curve creator vault holds
 *      pre-graduation fees (native SOL) and the AMM creator-vault ATA holds
 *      post-graduation fees (WSOL). The keeper — sole signer, no authority —
 *      consolidates the AMM WSOL into the curve vault
 *      (transfer_creator_fees_to_pump_v2) and collects everything to the
 *      vault as native SOL in one tx, through the real sweepVault core.
 */
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  GLOBAL_PDA,
  PumpSdk,
  getBuySolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import {
  PumpAmmSdk,
  GLOBAL_CONFIG_PDA as AMM_GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  canonicalPumpPoolPda,
  coinCreatorVaultAtaPda,
  coinCreatorVaultAuthorityPda,
} from "@pump-fun/pump-swap-sdk";
import { ProposalState } from "@solana/spl-governance";
import type { Connection } from "@solana/web3.js";
import type { ProgramTestContext } from "solana-bankrun";
import {
  buildAmmBuybackIxs,
  buildProvideLiquidityIxs,
} from "../packages/sdk/src/actions";
import { PumpFunRail } from "../packages/sdk/src/rails/pumpfun";
import { derivePumpCreatorVault } from "../packages/sdk/src/pda";
import {
  sweepVault,
  type KeeperDeps,
} from "../packages/keeper/src/keeper";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  prefundMissingWritables,
  proposeInner,
  send,
  startPumpCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const pumpSdk = new PumpSdk(); // offline builder/decoder
const ammSdk = new PumpAmmSdk(); // offline builder/decoder

type BankrunAccount = {
  executable: boolean;
  owner: PublicKey;
  lamports: number | bigint;
  data: Uint8Array;
};

function toInfo(a: BankrunAccount) {
  return {
    executable: a.executable,
    owner: a.owner,
    lamports: Number(a.lamports),
    data: Buffer.from(a.data),
  };
}

async function info(ctx: ProgramTestContext, address: PublicKey) {
  const a = await ctx.banksClient.getAccount(address);
  if (!a) throw new Error(`missing account ${address.toBase58()}`);
  return toInfo(a);
}

async function tokenAmount(
  ctx: ProgramTestContext,
  ata: PublicKey,
  program: PublicKey,
) {
  const a = await ctx.banksClient.getAccount(ata);
  if (!a) return 0n;
  return unpackAccount(ata, toInfo(a), program).amount;
}

// pump-swap-sdk state takes the RAW borsh structs; adapt the decoded
// spl-token shapes (only supply/decimals/amount are read by the math).
function toRawMint(m: ReturnType<typeof unpackMint>) {
  return {
    mintAuthorityOption: m.mintAuthority ? (1 as const) : (0 as const),
    mintAuthority: m.mintAuthority ?? PublicKey.default,
    supply: m.supply,
    decimals: m.decimals,
    isInitialized: m.isInitialized,
    freezeAuthorityOption: m.freezeAuthority ? (1 as const) : (0 as const),
    freezeAuthority: m.freezeAuthority ?? PublicKey.default,
  };
}

function toRawAccount(a: ReturnType<typeof unpackAccount>) {
  return {
    mint: a.mint,
    owner: a.owner,
    amount: a.amount,
    delegateOption: a.delegate ? (1 as const) : (0 as const),
    delegate: a.delegate ?? PublicKey.default,
    state: 1,
    isNativeOption: a.isNative ? (1 as const) : (0 as const),
    isNative: a.rentExemptReserve ?? 0n,
    delegatedAmount: a.delegatedAmount,
    closeAuthorityOption: a.closeAuthority ? (1 as const) : (0 as const),
    closeAuthority: a.closeAuthority ?? PublicKey.default,
  };
}

describe("13.6b post-graduation: migrate + AMM buyback + provideLiquidity (real binaries, bankrun)", () => {
  it(
    "the token graduates permissionlessly with coinCreator == vault; the DAO then buys back from its own pool and provides liquidity, by vote (staged legs, D-022)",
    async () => {
      const ctx = await startPumpCtx();
      const dao = await createDao(ctx, "cypherpunk");

      // ---- launch the DAO's token (creator == vault, INV-1)
      const mint = Keypair.generate();
      const createIx = await pumpSdk.createV2Instruction({
        mint: mint.publicKey,
        name: "daofun amm",
        symbol: "AMM",
        uri: "https://x.test/amm.json",
        creator: dao.vaultPda,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      await send(ctx, [createIx], [mint]);
      const curvePda = createIx.keys[2]!.pubkey;

      const global = pumpSdk.decodeGlobal(await info(ctx, GLOBAL_PDA));

      // ---- a whale buys out the curve so it completes
      const whale = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: whale.publicKey,
            lamports: 120_000_000_000, // 120 SOL: ~85 SOL curve + fees + slippage
          }),
        ],
        [],
      );
      const curveInfo0 = await info(ctx, curvePda);
      const curve0 = pumpSdk.decodeBondingCurve(curveInfo0);
      const allTokens = curve0.realTokenReserves;
      const buyOutIxs = await pumpSdk.buyInstructions({
        global,
        bondingCurveAccountInfo: curveInfo0,
        bondingCurve: curve0,
        associatedUserAccountInfo: null,
        mint: mint.publicKey,
        user: whale.publicKey,
        amount: allTokens,
        solAmount: getBuySolAmountFromTokenAmount({
          global,
          feeConfig: null,
          mintSupply: null,
          bondingCurve: curve0,
          amount: allTokens,
          quoteMint: NATIVE_MINT,
        }),
        slippage: 5,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });
      await prefundMissingWritables(ctx, buyOutIxs);
      await send(
        ctx,
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...buyOutIxs],
        [whale],
        whale,
      );
      expect(pumpSdk.decodeBondingCurve(await info(ctx, curvePda)).complete).toBe(
        true,
      );

      // ---- graduation is PERMISSIONLESS: any user migrates the complete
      // curve; withdrawAuthority comes from global state, not a signature.
      const migrateIx = await pumpSdk.migrateV2Instruction({
        withdrawAuthority: global.withdrawAuthority,
        mint: mint.publicKey,
        user: ctx.payer.publicKey,
        quoteMint: NATIVE_MINT,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });
      await prefundMissingWritables(ctx, [migrateIx]);
      await send(
        ctx,
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), migrateIx],
        [],
      );

      // The canonical pool exists and the DAO's vault stays the coin
      // creator — the creator-fee stream survives graduation.
      const poolKey = canonicalPumpPoolPda(mint.publicKey);
      const pool = ammSdk.decodePool(await info(ctx, poolKey));
      expect(pool.coinCreator.equals(dao.vaultPda)).toBe(true);
      expect(pool.baseMint.equals(mint.publicKey)).toBe(true);

      // ---- shared AMM state assembly (offline, from chain accounts)
      const globalConfig = ammSdk.decodeGlobalConfig(
        await info(ctx, AMM_GLOBAL_CONFIG_PDA),
      );
      const feeConfig = ammSdk.decodeFeeConfig(
        await info(ctx, PUMP_AMM_FEE_CONFIG_PDA),
      );
      const treasury = dao.nativeTreasury; // the acting wallet (D-022)
      const treasuryBaseAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        treasury,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      const treasuryWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        treasury,
        true,
        TOKEN_PROGRAM_ID,
      );
      const treasuryLpAta = getAssociatedTokenAddressSync(
        pool.lpMint,
        treasury,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultBaseAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        dao.vaultPda,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      const vaultLpAta = getAssociatedTokenAddressSync(
        pool.lpMint,
        dao.vaultPda,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      const creatorVaultAuthority = coinCreatorVaultAuthorityPda(dao.vaultPda);
      const creatorVaultAta = coinCreatorVaultAtaPda(
        creatorVaultAuthority,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
      );

      // Every ATA the proposals touch is created permissionlessly OUTSIDE
      // the proposals (D-019 size ceiling), incl. the fee recipients' WSOL
      // ATAs that exist on mainnet but not in a fresh bankrun.
      const ata = (
        ataAddr: PublicKey,
        owner: PublicKey,
        tokenMint: PublicKey,
        program: PublicKey,
      ) =>
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          ataAddr,
          owner,
          tokenMint,
          program,
        );
      const ataIxs = [
        ata(treasuryBaseAta, treasury, mint.publicKey, TOKEN_2022_PROGRAM_ID),
        ata(treasuryWsolAta, treasury, NATIVE_MINT, TOKEN_PROGRAM_ID),
        ata(treasuryLpAta, treasury, pool.lpMint, TOKEN_2022_PROGRAM_ID),
        ata(vaultBaseAta, dao.vaultPda, mint.publicKey, TOKEN_2022_PROGRAM_ID),
        ata(vaultLpAta, dao.vaultPda, pool.lpMint, TOKEN_2022_PROGRAM_ID),
        ata(creatorVaultAta, creatorVaultAuthority, NATIVE_MINT, TOKEN_PROGRAM_ID),
        ...[
          ...globalConfig.protocolFeeRecipients,
          ...globalConfig.buybackFeeRecipients,
        ].map((recipient) =>
          ata(
            getAssociatedTokenAddressSync(
              NATIVE_MINT,
              recipient,
              true,
              TOKEN_PROGRAM_ID,
            ),
            recipient,
            NATIVE_MINT,
            TOKEN_PROGRAM_ID,
          ),
        ),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: dao.vaultPda,
          lamports: 2_000_000_000, // 2 SOL of treasury to spend from
        }),
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: dao.nativeTreasury,
          lamports: 24_000_000, // D-016 execution rent for two proposals
        }),
      ];
      for (let i = 0; i < ataIxs.length; i += 6) {
        await send(ctx, ataIxs.slice(i, i + 6), []);
      }

      const baseMintAccount = toRawMint(
        unpackMint(
          mint.publicKey,
          await info(ctx, mint.publicKey),
          TOKEN_2022_PROGRAM_ID,
        ),
      );
      const readPoolAmounts = async () => ({
        base: await tokenAmount(
          ctx,
          pool.poolBaseTokenAccount,
          TOKEN_2022_PROGRAM_ID,
        ),
        quote: await tokenAmount(ctx, pool.poolQuoteTokenAccount, TOKEN_PROGRAM_ID),
      });

      // ========= proposal 0: buyback on the AMM (staged, D-022) =========
      const SPEND = 500_000_000n; // 0.5 SOL
      const poolBefore = await readPoolAmounts();
      const vaultBefore = await balance(ctx, dao.vaultPda);
      const buyback = await buildAmmBuybackIxs({
        vault: dao.vaultPda,
        nativeTreasury: treasury,
        mint: mint.publicKey,
        solLamports: SPEND,
        vaultBalanceLamports: BigInt(vaultBefore),
        swapState: {
          globalConfig,
          feeConfig,
          poolKey,
          poolAccountInfo: await info(ctx, poolKey),
          pool,
          poolBaseAmount: new BN(poolBefore.base.toString()),
          poolQuoteAmount: new BN(poolBefore.quote.toString()),
          baseTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          baseMint: mint.publicKey,
          baseMintAccount,
          user: treasury,
          userBaseTokenAccount: treasuryBaseAta,
          userQuoteTokenAccount: treasuryWsolAta,
          userBaseAccountInfo: await info(ctx, treasuryBaseAta),
          userQuoteAccountInfo: await info(ctx, treasuryWsolAta),
        },
      });
      const staged = buyback.vaultIxs[0]!.data.readBigUInt64LE(4); // maxQuote
      await prefundMissingWritables(ctx, [
        ...buyback.vaultIxs,
        ...buyback.treasuryIxs,
      ]);

      const made0 = await proposeInner(
        ctx,
        dao,
        0,
        buyback.vaultIxs,
        "amm buyback 0.5 SOL",
        buyback.treasuryIxs,
      );
      await castCommunityYes(ctx, dao, made0.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made0.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made0);

      // the bought tokens came back to the VAULT's custody...
      const boughtBase = await tokenAmount(ctx, vaultBaseAta, TOKEN_2022_PROGRAM_ID);
      expect(boughtBase > 0n).toBe(true);
      // ...paid by exactly the staged maxQuote leaving the vault...
      const vaultAfterBuyback = await balance(ctx, dao.vaultPda);
      expect(BigInt(vaultBefore - vaultAfterBuyback)).toBe(staged);
      // ...the pool's quote reserve grew...
      const poolAfterBuyback = await readPoolAmounts();
      expect(poolAfterBuyback.quote > poolBefore.quote).toBe(true);
      // ...and the buy's creator fee (WSOL on the AMM venue) flowed to the
      // DAO's own creator vault ATA.
      expect(
        await tokenAmount(ctx, creatorVaultAta, TOKEN_PROGRAM_ID),
      ).toBeGreaterThan(0n);

      // ===== proposal 1: provideLiquidity (staged, D-022) =====
      // the buy's close unwrapped the treasury's WSOL ATA — re-create it
      // permissionlessly for the next action.
      await send(
        ctx,
        [ata(treasuryWsolAta, treasury, NATIVE_MINT, TOKEN_PROGRAM_ID)],
        [],
      );
      const QUOTE_IN = 200_000_000n; // 0.2 SOL
      const vaultBaseBefore = boughtBase;
      const provide = await buildProvideLiquidityIxs({
        vault: dao.vaultPda,
        nativeTreasury: treasury,
        mint: mint.publicKey,
        quoteLamports: QUOTE_IN,
        vaultBalanceLamports: BigInt(await balance(ctx, dao.vaultPda)),
        vaultBaseTokenBalance: vaultBaseBefore,
        liquidityState: {
          globalConfig,
          poolKey,
          poolAccountInfo: await info(ctx, poolKey),
          pool,
          poolBaseTokenAccount: toRawAccount(
            unpackAccount(
              pool.poolBaseTokenAccount,
              await info(ctx, pool.poolBaseTokenAccount),
              TOKEN_2022_PROGRAM_ID,
            ),
          ),
          poolQuoteTokenAccount: toRawAccount(
            unpackAccount(
              pool.poolQuoteTokenAccount,
              await info(ctx, pool.poolQuoteTokenAccount),
              TOKEN_PROGRAM_ID,
            ),
          ),
          baseTokenProgram: TOKEN_2022_PROGRAM_ID,
          quoteTokenProgram: TOKEN_PROGRAM_ID,
          user: treasury,
          userBaseTokenAccount: treasuryBaseAta,
          userQuoteTokenAccount: treasuryWsolAta,
          userPoolTokenAccount: treasuryLpAta,
          userBaseAccountInfo: await info(ctx, treasuryBaseAta),
          userQuoteAccountInfo: await info(ctx, treasuryWsolAta),
          userPoolAccountInfo: await info(ctx, treasuryLpAta),
        },
      });
      await prefundMissingWritables(ctx, [
        ...provide.vaultIxs,
        ...provide.treasuryIxs,
      ]);

      const made1 = await proposeInner(
        ctx,
        dao,
        1,
        provide.vaultIxs,
        "provide liquidity 0.2 SOL",
        provide.treasuryIxs,
      );
      await castCommunityYes(ctx, dao, made1.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made1.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made1);

      // the LP position is in the VAULT's custody; both pool reserves
      // grew; the vault's base contribution left its ATA.
      expect(
        await tokenAmount(ctx, vaultLpAta, TOKEN_2022_PROGRAM_ID),
      ).toBeGreaterThan(0n);
      const poolAfterDeposit = await readPoolAmounts();
      expect(poolAfterDeposit.base > poolAfterBuyback.base).toBe(true);
      expect(poolAfterDeposit.quote > poolAfterBuyback.quote).toBe(true);
      expect(
        await tokenAmount(ctx, vaultBaseAta, TOKEN_2022_PROGRAM_ID),
      ).toBeLessThan(vaultBaseBefore);

      // ===== keeper sweep (spec 6.5): both venues, one native-SOL credit =====
      const keeper = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: keeper.publicKey,
            lamports: 1_000_000_000,
          }),
        ],
        [],
      );
      // the rail reads chain state through the Connection surface only; in
      // bankrun a one-method adapter over banksClient suffices.
      const rail = new PumpFunRail({
        getMultipleAccountsInfo: async (keys: PublicKey[]) =>
          Promise.all(
            keys.map(async (k) => {
              const a = await ctx.banksClient.getAccount(k);
              return a ? toInfo(a) : null;
            }),
          ),
      } as unknown as Connection);

      const FLOOR = 890_880n; // rent-exempt min for a 0-data account (D-009)
      const curveVault = derivePumpCreatorVault(dao.vaultPda);
      const curveAccrued = BigInt(await balance(ctx, curveVault)) - FLOOR;
      const ammAccrued = await tokenAmount(ctx, creatorVaultAta, TOKEN_PROGRAM_ID);
      // pre-graduation curve fees AND post-graduation AMM fees are both live
      expect(curveAccrued).toBeGreaterThan(0n);
      expect(ammAccrued).toBeGreaterThan(0n);

      const deps: KeeperDeps = {
        keeper: keeper.publicKey,
        getAccruedFees: async () => {
          const lamports = BigInt(await balance(ctx, curveVault));
          const curve = lamports > FLOOR ? lamports - FLOOR : 0n;
          return curve + (await tokenAmount(ctx, creatorVaultAta, TOKEN_PROGRAM_ID));
        },
        getVaultBalance: async () => BigInt(await balance(ctx, dao.vaultPda)),
        buildCollectIxs: (v, payer) => rail.buildCollectFeesIxs(v, payer),
        sendAndConfirm: async (ixs) => {
          await send(
            ctx,
            [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs],
            [keeper],
            keeper,
          );
          return "bankrun";
        },
        maxAttempts: 1,
        backoffMs: 1,
      };

      const vaultBeforeSweep = BigInt(await balance(ctx, dao.vaultPda));
      const sweep = await sweepVault(dao.vaultPda, deps);
      expect(sweep).not.toBeNull();

      // INV-8 gross accounting: the vault received at least both venues'
      // accruals (consolidation may release WSOL-ATA rent on top), as
      // native SOL, with the keeper as the only signer (INV-2 was checked
      // inside sweepVault against the REAL instruction set).
      const vaultAfterSweep = BigInt(await balance(ctx, dao.vaultPda));
      expect(vaultAfterSweep - vaultBeforeSweep).toBe(sweep!.grossLamports);
      expect(sweep!.grossLamports).toBeGreaterThanOrEqual(
        curveAccrued + ammAccrued,
      );
      // the AMM venue drained; the curve vault is back at its rent floor
      expect(await tokenAmount(ctx, creatorVaultAta, TOKEN_PROGRAM_ID)).toBe(0n);
      expect(BigInt(await balance(ctx, curveVault))).toBe(FLOOR);
      // idempotency on real state: nothing left, second sweep is a no-op
      expect(await sweepVault(dao.vaultPda, deps)).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
