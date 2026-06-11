/**
 * 13.6b buyback action — governance-executed buy on the token's OWN curve
 * (spec 6.8), against the REAL pump + governance + Squads binaries:
 *
 *   DAO launches its token (creator == vault) -> the vault accumulates SOL
 *   -> a buyback proposal (buildBuybackIxs through buildProposeIxs) ->
 *   vote -> 72h hold-up -> execute: the VAULT buys its own token from the
 *   curve, paying with treasury SOL, and — because the vault IS the coin
 *   creator — the buy's creator fee flows straight back to the vault.
 *
 * Exercises the full D-019 machinery in a second real scenario: the buy's
 * ~27-account instruction forces the buffered ExecutionAdapter chain and
 * the v0+ALT-packed execute insert.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { GLOBAL_PDA, PumpSdk } from "@pump-fun/pump-sdk";
import { ProposalState } from "@solana/spl-governance";
import { buildBuybackIxs } from "../packages/sdk/src/actions";
import { derivePumpCreatorVault } from "../packages/sdk/src/pda";
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

describe("action menu: buyback on the curve (real binaries, bankrun)", () => {
  it(
    "the DAO votes to buy its own token with vault SOL; the vault receives the tokens AND the buy's creator fee (it is the creator)",
    async () => {
      const ctx = await startPumpCtx();
      const dao = await createDao(ctx, "cypherpunk");

      // The DAO's token: creator == vault (INV-1).
      const mint = Keypair.generate();
      const createIx = await pumpSdk.createV2Instruction({
        mint: mint.publicKey,
        name: "daofun buyback",
        symbol: "BBK",
        uri: "https://x.test/bbk.json",
        creator: dao.vaultPda,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      await send(ctx, [createIx], [mint]);
      const curvePda = createIx.keys[2]!.pubkey;

      // Vault ATA is created permissionlessly OUTSIDE the proposal (D-019
      // size ceiling); treasury gets D-016 execution rent; the vault gets
      // the SOL it will spend.
      const vaultAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        dao.vaultPda,
        true,
        TOKEN_2022_PROGRAM_ID,
      );
      await send(
        ctx,
        [
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            vaultAta,
            dao.vaultPda,
            mint.publicKey,
            TOKEN_2022_PROGRAM_ID,
          ),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.vaultPda,
            lamports: 1_000_000_000, // 1 SOL of treasury to spend from
          }),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.nativeTreasury,
            lamports: 12_000_000,
          }),
        ],
        [],
      );

      const toInfo = (a: {
        executable: boolean;
        owner: import("@solana/web3.js").PublicKey;
        lamports: number | bigint;
        data: Uint8Array;
      }) => ({
        executable: a.executable,
        owner: a.owner,
        lamports: Number(a.lamports),
        data: Buffer.from(a.data),
      });
      const global = pumpSdk.decodeGlobal(
        toInfo((await ctx.banksClient.getAccount(GLOBAL_PDA))!),
      );
      const curveInfo = toInfo((await ctx.banksClient.getAccount(curvePda))!);
      const curve = pumpSdk.decodeBondingCurve(curveInfo);

      const SPEND = 500_000_000n; // 0.5 SOL
      const vaultBefore = await balance(ctx, dao.vaultPda);
      const inner = await buildBuybackIxs({
        vault: dao.vaultPda,
        mint: mint.publicKey,
        solLamports: SPEND,
        vaultBalanceLamports: BigInt(vaultBefore),
        global,
        bondingCurveAccountInfo: curveInfo,
        bondingCurve: curve,
      });
      // fee recipients must not end below the rent floor (D-009)
      await prefundMissingWritables(ctx, inner);

      const made = await proposeInner(ctx, dao, 0, inner, "buyback 0.5 SOL");
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      // The vault holds the bought tokens...
      const ataInfo = await ctx.banksClient.getAccount(vaultAta);
      const bought = unpackAccount(
        vaultAta,
        toInfo(ataInfo!),
        TOKEN_2022_PROGRAM_ID,
      ).amount;
      expect(bought > 0n).toBe(true);

      // ...paid with treasury SOL (spend + pump fees)...
      const vaultAfter = await balance(ctx, dao.vaultPda);
      expect(vaultBefore - vaultAfter).toBeGreaterThanOrEqual(Number(SPEND));

      // ...the curve received the SOL...
      const curveAfter = pumpSdk.decodeBondingCurve(
        toInfo((await ctx.banksClient.getAccount(curvePda))!),
      );
      expect(
        curveAfter.realQuoteReserves.gt(curve.realQuoteReserves),
      ).toBe(true);

      // ...and the buy's creator fee flowed back to the DAO's own creator
      // vault (the vault IS the coin creator) — sweepable by the keeper.
      expect(
        await balance(ctx, derivePumpCreatorVault(dao.vaultPda)),
      ).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});
