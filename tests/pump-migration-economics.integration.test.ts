/**
 * Reference economics — what a pump.fun graduation ACTUALLY costs, measured
 * on the deployed pump + pump_amm binaries rather than taken from a blog.
 *
 * This is competitive research kept as a test on purpose. We are deciding how
 * to fund our own graduation (PLAN-GRADUATED-FEES.md, D-049), and the widely
 * repeated "pump takes 6 SOL to migrate" number is from the Raydium era and
 * is no longer true. Numbers this suite pins:
 *
 *   - pump's live curve fee split (protocol vs creator basis points),
 *   - `pool_migration_fee` — what pump CHARGES at graduation,
 *   - what graduation actually COSTS in rent, and who pays it,
 *   - how much of the raise reaches the pool.
 *
 * The answer, in one line: the RAISE funds graduation, not pump's protocol
 * revenue. pump charges 0.015 SOL against the raise, spends 0.0082 of it on
 * the pool's rent, and keeps 0.0068. Whoever cranks migrate pays nothing.
 *
 * Both launchpads use identical curve parameters (30 SOL virtual, 793.1M
 * sellable, 1e15 supply), so every lamport here is directly comparable to
 * ours. If pump changes their model, this suite fails and we find out.
 *
 * Run: pnpm test:integration
 */
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  GLOBAL_PDA,
  PumpSdk,
  getBuySolAmountFromTokenAmount,
  pumpIdl,
} from "@pump-fun/pump-sdk";
import { canonicalPumpPoolPda } from "@pump-fun/pump-swap-sdk";
import type { ProgramTestContext } from "solana-bankrun";
import {
  TEST_TIMEOUT,
  balance,
  prefundMissingWritables,
  send,
  startPumpCtx,
} from "./helpers/bankrun-harness";

const pumpSdk = new PumpSdk(); // offline builder/decoder

async function info(ctx: ProgramTestContext, address: PublicKey) {
  const a = await ctx.banksClient.getAccount(address);
  if (!a) throw new Error(`account ${address.toBase58()} missing`);
  return {
    executable: a.executable,
    owner: new PublicKey(a.owner),
    lamports: Number(a.lamports),
    data: Buffer.from(a.data),
  };
}

describe("reference: what a pump.fun graduation costs (deployed binaries)", () => {
  it(
    "funds graduation entirely from the raise: a 0.015 SOL fee pays the pool's rent and the cranker pays nothing",
    async () => {
      const ctx = await startPumpCtx();
      const global = pumpSdk.decodeGlobal(await info(ctx, GLOBAL_PDA));

      // ---- pump's live curve economics, for side-by-side with ours.
      // Same curve shape as PUMP_CLASSIC; only the fee SPLIT differs.
      expect(Number(global.initialVirtualSolReserves)).toBe(30_000_000_000);
      expect(Number(global.initialRealTokenReserves)).toBe(793_100_000_000_000);
      // 0.95% protocol + 0.05% creator = 1.00% total, same headline as ours,
      // but pump keeps 19x what the creator does on the way up (we keep 2.3x).
      expect(Number(global.feeBasisPoints)).toBe(95);
      expect(Number(global.creatorFeeBasisPoints)).toBe(5);
      // THE number: not 6 SOL. Since PumpSwap, graduation is a 0.015 SOL fee.
      expect(Number(global.poolMigrationFee)).toBe(15_000_001);

      // ---- launch and buy the curve out so it completes.
      const mint = Keypair.generate();
      const creator = Keypair.generate();
      const createIx = await pumpSdk.createV2Instruction({
        mint: mint.publicKey,
        name: "econ probe",
        symbol: "ECON",
        uri: "https://x.test/econ.json",
        creator: creator.publicKey,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      await send(ctx, [createIx], [mint]);
      const curvePda = createIx.keys[2]!.pubkey;

      const whale = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: whale.publicKey,
            lamports: 120_000_000_000,
          }),
        ],
        [],
      );
      const curveInfo0 = await info(ctx, curvePda);
      const curve0 = pumpSdk.decodeBondingCurve(curveInfo0);
      const buyOutIxs = await pumpSdk.buyInstructions({
        global,
        bondingCurveAccountInfo: curveInfo0,
        bondingCurve: curve0,
        associatedUserAccountInfo: null,
        mint: mint.publicKey,
        user: whale.publicKey,
        amount: curve0.realTokenReserves,
        solAmount: getBuySolAmountFromTokenAmount({
          global,
          feeConfig: null,
          mintSupply: null,
          bondingCurve: curve0,
          amount: curve0.realTokenReserves,
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
      const completed = pumpSdk.decodeBondingCurve(await info(ctx, curvePda));
      expect(completed.complete).toBe(true);

      // The raise sits as lamports ON the curve account, above its own rent.
      const curveRent = Number(
        (await ctx.banksClient.getRent()).minimumBalance(
          BigInt(curveInfo0.data.length),
        ),
      );
      const curveLamportsBefore = await balance(ctx, curvePda);
      const raise = curveLamportsBefore - curveRent;
      // ~85 SOL, the same completion raise our curve has.
      expect(raise).toBeGreaterThan(84_000_000_000);
      expect(raise).toBeLessThan(86_000_000_000);

      // ---- migrate, accounting for every lamport.
      const migrateIx = await pumpSdk.migrateV2Instruction({
        withdrawAuthority: global.withdrawAuthority,
        mint: mint.publicKey,
        user: ctx.payer.publicKey,
        quoteMint: NATIVE_MINT,
        baseTokenProgram: TOKEN_2022_PROGRAM_ID,
        quoteTokenProgram: TOKEN_PROGRAM_ID,
      });

      // Deliberately NOT calling prefundMissingWritables here: seeding rent
      // into accounts migrate is about to create would hide who really pays
      // for them, which is the whole question. migrate funds its own.
      const writables = [
        ...new Set(
          migrateIx.keys
            .filter((k) => k.isWritable && !k.isSigner)
            .map((k) => k.pubkey.toBase58()),
        ),
      ].map((s) => new PublicKey(s));
      const existedBefore = new Set<string>();
      for (const w of writables) {
        if (await ctx.banksClient.getAccount(w)) existedBefore.add(w.toBase58());
      }

      const payerBefore = await balance(ctx, ctx.payer.publicKey);
      const withdrawBefore = await balance(ctx, global.withdrawAuthority);
      await send(
        ctx,
        [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), migrateIx],
        [],
      );
      const payerAfter = await balance(ctx, ctx.payer.publicKey);
      const withdrawAfter = await balance(ctx, global.withdrawAuthority);

      // 1. The migration fee is credited to withdraw_authority — but the
      // SAME account is the rent payer for everything migrate creates, so
      // its net delta is fee minus rent, not the fee.
      const withdrawNet = withdrawAfter - withdrawBefore;

      // 2. Rent for the accounts migrate created from nothing. Use the rent
      // sysvar per data length rather than raw lamports: the pool's quote
      // vault also holds the raise as wSOL, which is liquidity, not rent.
      const rent = await ctx.banksClient.getRent();
      // Name every account from the IDL so the ledger below is readable.
      const idlNames = (
        pumpIdl.instructions.find((i) => i.name === "migrate_v2")!.accounts as {
          name: string;
        }[]
      ).map((a) => a.name);
      const nameOf = (key: PublicKey) => {
        const i = migrateIx.keys.findIndex((k) => k.pubkey.equals(key));
        return idlNames[i] ?? "?";
      };
      let poolRent = 0;
      const created: string[] = [];
      for (const w of writables) {
        if (existedBefore.has(w.toBase58())) continue;
        const acc = await ctx.banksClient.getAccount(w);
        if (!acc) continue;
        const name = nameOf(w);
        // withdraw_authority is where the fee LANDS, not a pool account.
        if (name !== "withdraw_authority") {
          poolRent += Number(rent.minimumBalance(BigInt(acc.data.length)));
        }
        created.push(`${name}(${acc.data.length}B)`);
      }

      // 3. The cranker is the only signer. If it pays nothing beyond its
      // signature, pump is funding graduation itself.
      const paidByCranker = payerBefore - payerAfter - 5_000;

      const poolKey = canonicalPumpPoolPda(mint.publicKey);
      expect((await info(ctx, poolKey)).data.length).toBeGreaterThan(0);
      // What actually reached the pool as liquidity (wSOL amount, not rent).
      const quoteVault = migrateIx.keys[idlNames.indexOf("pool_quote_token_account")]!;
      const seeded =
        (await info(ctx, quoteVault.pubkey)).data.readBigUInt64LE(64);

       
      console.log(
        [
          "",
          "pump.fun graduation, measured on the deployed binaries",
          `  raise at completion        ${(raise / 1e9).toFixed(9)} SOL`,
          `  pool_migration_fee charged ${(Number(global.poolMigrationFee) / 1e9).toFixed(9)} SOL`,
          `    of which pool rent       ${(poolRent / 1e9).toFixed(9)} SOL`,
          `    net kept by pump         ${(withdrawNet / 1e9).toFixed(9)} SOL`,
          `  seeded into the pool       ${(Number(seeded) / 1e9).toFixed(9)} SOL`,
          `  paid by the cranker        ${(paidByCranker / 1e9).toFixed(9)} SOL`,
          `  accounts created           ${created.join(", ")}`,
          "",
        ].join("\n"),
      );

      // The ledger closes exactly, and it is the answer to "who funds
      // graduation": the RAISE does. pump charges 0.015 SOL against it, pays
      // the pool's rent out of that fee, and keeps the remainder. The
      // cranker — anyone, migrate_v2's only signer — pays nothing but its
      // own signature, so graduation is free to trigger and self-funding.
      expect(paidByCranker).toBe(0);
      expect(poolRent).toBe(8_171_040);
      expect(withdrawNet).toBe(Number(global.poolMigrationFee) - poolRent);
      expect(withdrawNet).toBe(6_828_961); // pump's true take: 0.0068 SOL
      expect(Number(seeded)).toBe(raise - Number(global.poolMigrationFee));

    },
    TEST_TIMEOUT,
  );
});
