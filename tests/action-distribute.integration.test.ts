/**
 * 13.6b `distribute` — against the REAL merkle distributor binary (the
 * IMMUTABLE mainnet deployment mERKc..., D-024) + governance + Squads:
 *
 *   1. ONE proposal (vault legs through the custody chain): newDistributor
 *      with the vault as admin/rent-payer, root pinned at proposal time
 *      (INV-9 covers it), fund the distributor's WSOL vault with exactly
 *      Σ(shares), sync. Claim/clawback timestamps account for governance
 *      latency (the program requires them in the future at EXECUTION).
 *   2. Holders claim permissionlessly with proofs from OUR tree builder —
 *      the real on-chain verifier accepting them proves the TS hashing
 *      (sha256, [0]/[1] prefixes, commutative fold) is byte-compatible.
 *   3. Double-claims are impossible (ClaimStatus PDA); wrong amounts fail
 *      the proof; after clawbackStartTs ANYONE returns the remainder to
 *      the vault's WSOL ATA; the books close exactly:
 *      claimed₁ + claimed₂ + clawed-back == funded.
 */
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
} from "@solana/spl-token";
import { ProposalState } from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from "../packages/sdk/src/constants";
import { buildDistributeIxs } from "../packages/sdk/src/actions";
import {
  buildClawbackIx,
  buildNewClaimIx,
} from "../packages/sdk/src/merkle-distributor";
import {
  BASE_VOTING_TIME_S,
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  proposeInner,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

async function wsolAmount(ctx: ProgramTestContext, ata: PublicKey) {
  const a = await ctx.banksClient.getAccount(ata);
  if (!a) return 0n;
  return unpackAccount(
    ata,
    {
      executable: a.executable,
      owner: a.owner,
      lamports: Number(a.lamports),
      data: Buffer.from(a.data),
    },
    TOKEN_PROGRAM_ID,
  ).amount;
}

describe("13.6b distribute: merkle claim distributor (real binary, bankrun)", () => {
  it(
    "the DAO votes a snapshot distribution; holders claim with our proofs; double-claims fail; clawback returns the remainder to the vault",
    async () => {
      const ctx = await startCtx([
        { name: "merkle_distributor", programId: MERKLE_DISTRIBUTOR_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx, "cypherpunk");

      // three snapshot holders with uneven shares (0.3 / 0.2 / 0.1 SOL)
      const holders = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
      const shares = [
        { claimant: holders[0]!.publicKey, lamports: 300_000_000n },
        { claimant: holders[1]!.publicKey, lamports: 200_000_000n },
        { claimant: holders[2]!.publicKey, lamports: 100_000_000n },
      ];

      const vaultWsolAta = getAssociatedTokenAddressSync(
        NATIVE_MINT,
        dao.vaultPda,
        true,
      );
      // fund the vault + claimants; pre-create every ATA permissionlessly
      // OUTSIDE the proposal (D-019): the clawback receiver and the
      // claimants' WSOL destinations.
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.vaultPda,
            lamports: 2_000_000_000,
          }),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.nativeTreasury,
            lamports: 12_000_000, // D-016 execution rent
          }),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            vaultWsolAta,
            dao.vaultPda,
            NATIVE_MINT,
          ),
          ...holders.map((h) =>
            SystemProgram.transfer({
              fromPubkey: ctx.payer.publicKey,
              toPubkey: h.publicKey,
              lamports: 50_000_000, // claim fees + ClaimStatus rent
            }),
          ),
        ],
        [],
      );
      await send(
        ctx,
        holders.map((h) =>
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            getAssociatedTokenAddressSync(NATIVE_MINT, h.publicKey, false),
            h.publicKey,
            NATIVE_MINT,
          ),
        ),
        [],
      );

      // ===== proposal: create + fund the distributor (vault legs) =====
      // The program requires every timestamp to be in the FUTURE when
      // newDistributor EXECUTES — i.e. after the voting window + hold-up.
      const clock = await ctx.banksClient.getClock();
      const executeEta =
        clock.unixTimestamp +
        BigInt(BASE_VOTING_TIME_S) +
        BigInt(MICRO_HOLDUP_S) +
        600n;
      const startVestingTs = executeEta + 60n;
      const endVestingTs = executeEta + 120n;
      const clawbackStartTs = endVestingTs + 86_400n;
      const distribute = buildDistributeIxs({
        vault: dao.vaultPda,
        shares,
        version: 1n,
        startVestingTs,
        endVestingTs,
        clawbackStartTs,
        vaultBalanceLamports: BigInt(await balance(ctx, dao.vaultPda)),
      });

      const vaultBefore = BigInt(await balance(ctx, dao.vaultPda));
      const made = await proposeInner(
        ctx,
        dao,
        0,
        distribute.ixs,
        "distribute 0.6 SOL to 3 holders",
      );
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      // the distributor exists with OUR root pinned on chain...
      const distInfo = await ctx.banksClient.getAccount(distribute.distributor);
      expect(distInfo).not.toBeNull();
      // MerkleDistributor layout: 8 disc + bump u8 + version u64, then root
      const chainRoot = Buffer.from(distInfo!.data.slice(17, 49));
      expect(chainRoot.equals(distribute.tree.root)).toBe(true);
      // ...funded with exactly the share total from the vault
      expect(await wsolAmount(ctx, distribute.tokenVault)).toBe(600_000_000n);
      expect(vaultBefore - BigInt(await balance(ctx, dao.vaultPda))).toBe(
        600_000_000n +
          (BigInt(distInfo!.lamports) +
            2_039_280n) /* distributor + its ATA rent, vault-paid */,
      );

      // ===== claims: the REAL verifier accepts OUR proofs =====
      // warp from the CURRENT clock (post voting + hold-up) to just past
      // startVestingTs — well before clawbackStartTs.
      const afterExec = (await ctx.banksClient.getClock()).unixTimestamp;
      await warpSeconds(ctx, Number(startVestingTs - afterExec) + 5);

      const claim = (holder: Keypair, lamports: bigint, nonce: number) => {
        const built = buildNewClaimIx({
          distributor: distribute.distributor,
          claimant: holder.publicKey,
          amountUnlocked: lamports,
          proof: distribute.tree.proofFor(holder.publicKey),
        });
        return {
          built,
          ixs: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + nonce }),
            built.ix,
          ],
        };
      };

      const claim0 = claim(holders[0]!, shares[0]!.lamports, 1);
      await send(ctx, claim0.ixs, [holders[0]!], holders[0]!);
      expect(await wsolAmount(ctx, claim0.built.to)).toBe(300_000_000n);

      // double-claim impossible: the ClaimStatus PDA already exists
      const again = claim(holders[0]!, shares[0]!.lamports, 2);
      expect(
        await sendExpectFail(ctx, again.ixs, [holders[0]!]),
      ).toMatch(/already in use|custom program error/i);

      // a tampered amount fails the on-chain proof check
      const tampered = buildNewClaimIx({
        distributor: distribute.distributor,
        claimant: holders[1]!.publicKey,
        amountUnlocked: shares[1]!.lamports + 1n,
        proof: distribute.tree.proofFor(holders[1]!.publicKey),
      });
      expect(
        await sendExpectFail(ctx, [tampered.ix], [holders[1]!]),
      ).toMatch(/custom program error/i);

      const claim1 = claim(holders[1]!, shares[1]!.lamports, 3);
      await send(ctx, claim1.ixs, [holders[1]!], holders[1]!);
      expect(await wsolAmount(ctx, claim1.built.to)).toBe(200_000_000n);

      // ===== clawback: permissionless return of the remainder =====
      // before the window closes it is refused...
      const stranger = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: stranger.publicKey,
            lamports: 10_000_000,
          }),
        ],
        [],
      );
      const clawIx = buildClawbackIx({
        distributor: distribute.distributor,
        clawbackReceiver: distribute.clawbackReceiver,
        payer: stranger.publicKey,
      });
      expect(await sendExpectFail(ctx, [clawIx], [stranger])).toMatch(
        /custom program error/i,
      );

      // ...after clawbackStartTs anyone closes the books: holder 3's
      // unclaimed share returns to the VAULT's custody.
      const nowTs = (await ctx.banksClient.getClock()).unixTimestamp;
      await warpSeconds(ctx, Number(clawbackStartTs - nowTs) + 10);
      await send(ctx, [clawIx], [stranger], stranger);
      expect(await wsolAmount(ctx, distribute.tokenVault)).toBe(0n);
      expect(await wsolAmount(ctx, vaultWsolAta)).toBe(100_000_000n);

      // claims after clawback are refused (the window is truly closed)
      const late = claim(holders[2]!, shares[2]!.lamports, 4);
      expect(
        await sendExpectFail(ctx, late.ixs, [holders[2]!]),
      ).toMatch(/custom program error/i);

      // books: claimed + clawed back == funded, nothing stranded
      expect(300_000_000n + 200_000_000n + 100_000_000n).toBe(
        distribute.totalLamports,
      );
    },
    TEST_TIMEOUT,
  );
});
