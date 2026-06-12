/**
 * Stage 2 CU-budget suite (spec Section 8): "CU budget: measured per
 * executed governance tx; fail test if within 15% of limit."
 *
 * Every production execute runs with a 400k CU limit (the harness and the
 * mainnet GATE 1 runs both send it). This suite executes the launchpad's
 * three governance-tx shapes against the REAL binaries and fails if ANY
 * executed transaction consumes more than 85% of that limit:
 *
 *   - the 4-step Squads custody chain (grant/sweep — every vault action),
 *   - a direct leg (setParam: governance-signed config change),
 *   - the distribute chain (newDistributor + fund + sync, vault legs).
 *
 * Margins are printed into the assertion messages so the GATES.md
 * evidence can quote real numbers.
 */
import { describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, SystemProgram } from "@solana/web3.js";
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Governance, ProposalState } from "@solana/spl-governance";
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from "../packages/sdk/src/constants";
import {
  buildDistributeIxs,
  buildSetParamIxs,
} from "../packages/sdk/src/actions";
import {
  BASE_VOTING_TIME_S,
  MICRO_HOLDUP_S,
  SUPPLY,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  createDao,
  executeIxsFor,
  finalizeAfterVotingWindow,
  proposeInner,
  readGov,
  send,
  sendMeasured,
  startCtx,
  warpSeconds,
  type Dao,
  type MadeProposal,
} from "./helpers/bankrun-harness";
import type { ProgramTestContext } from "solana-bankrun";

const CU_LIMIT = 400_000n;
const CEILING = (CU_LIMIT * 85n) / 100n; // fail within 15% of the limit

async function executeAllMeasured(
  ctx: ProgramTestContext,
  dao: Dao,
  made: MadeProposal,
  label: string,
): Promise<bigint[]> {
  const consumed: bigint[] = [];
  for (let i = 0; i < made.ptAddrs.length; i++) {
    const cu = await sendMeasured(
      ctx,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: Number(CU_LIMIT) }),
        ...(await executeIxsFor(dao, made, i)),
      ],
      [],
    );
    expect(
      cu <= CEILING,
      `${label} execute[${i}] consumed ${cu} CU — within 15% of the ${CU_LIMIT} limit (ceiling ${CEILING})`,
    ).toBe(true);
    consumed.push(cu);
  }
  return consumed;
}

describe("Stage 2 CU budget: every executed governance tx stays under 85% of its limit (real binaries)", () => {
  it(
    "custody chain (grant), direct leg (setParam), and distribute chain all clear the ceiling",
    async () => {
      const ctx = await startCtx([
        { name: "merkle_distributor", programId: MERKLE_DISTRIBUTOR_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx, "cypherpunk");

      // extra funding for the distribute leg + the vault's WSOL ATA
      // (clawback receiver), pre-created OUTSIDE the proposal (D-019)
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.vaultPda,
            lamports: 1_000_000_000,
          }),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.nativeTreasury,
            lamports: 12_000_000,
          }),
          createAssociatedTokenAccountIdempotentInstruction(
            ctx.payer.publicKey,
            getAssociatedTokenAddressSync(NATIVE_MINT, dao.vaultPda, true),
            dao.vaultPda,
            NATIVE_MINT,
          ),
        ],
        [],
      );

      const report: Record<string, string[]> = {};

      // ===== shape 1: the 4-step Squads custody chain (grant/sweep) =====
      const recipient = Keypair.generate().publicKey;
      const grant = await proposeInner(
        ctx,
        dao,
        0,
        [
          SystemProgram.transfer({
            fromPubkey: dao.vaultPda,
            toPubkey: recipient,
            lamports: VAULT_FUND,
          }),
        ],
        "cu: grant",
      );
      await castCommunityYes(ctx, dao, grant.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, grant.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      report["custody-chain"] = (
        await executeAllMeasured(ctx, dao, grant, "custody-chain")
      ).map(String);
      expect(await balance(ctx, recipient)).toBe(VAULT_FUND);

      // ===== shape 2: direct leg (setParam) =====
      const gov = await readGov(ctx, dao.governance, Governance);
      const setParam = buildSetParamIxs({
        governance: dao.governance,
        currentConfig: gov.config,
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId: "quorumPercent",
        value: 30n,
      });
      const direct = await proposeInner(
        ctx,
        dao,
        1,
        [],
        "cu: setParam",
        setParam.directIxs,
      );
      await castCommunityYes(ctx, dao, direct.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, direct.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      report["direct-leg"] = (
        await executeAllMeasured(ctx, dao, direct, "direct-leg")
      ).map(String);

      // ===== shape 3: distribute (newDistributor + fund + sync) =====
      const clock = await ctx.banksClient.getClock();
      const executeEta =
        clock.unixTimestamp +
        BigInt(BASE_VOTING_TIME_S) +
        BigInt(MICRO_HOLDUP_S) +
        600n;
      const distribute = buildDistributeIxs({
        vault: dao.vaultPda,
        shares: [
          { claimant: Keypair.generate().publicKey, lamports: 100_000_000n },
          { claimant: Keypair.generate().publicKey, lamports: 200_000_000n },
        ],
        version: 99n,
        startVestingTs: executeEta + 60n,
        endVestingTs: executeEta + 120n,
        clawbackStartTs: executeEta + 120n + 86_400n,
        vaultBalanceLamports: BigInt(await balance(ctx, dao.vaultPda)),
      });
      const dist = await proposeInner(
        ctx,
        dao,
        2,
        distribute.ixs,
        "cu: distribute",
      );
      await castCommunityYes(ctx, dao, dist.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, dist.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      report["distribute-chain"] = (
        await executeAllMeasured(ctx, dao, dist, "distribute-chain")
      ).map(String);

      // evidence for GATES.md
      console.log("CU consumed per executed governance tx (limit 400000):");
      console.log(JSON.stringify(report, null, 2));
    },
    TEST_TIMEOUT,
  );
});
