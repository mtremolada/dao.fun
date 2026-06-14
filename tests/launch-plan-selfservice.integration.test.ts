/**
 * Self-service (decentralized) launch — proven on the real binaries.
 *
 * NO server key: a single user `wallet` is the launcher/fee-payer and signs
 * every group, co-signing only with the throwaway mint/createKey/councilMint
 * keypairs the browser would generate. buildLaunchPlan emits the ordered
 * groups; submitting them in order stands up the full DAO (Squads vault whose
 * sole member is the advance-derived native treasury, INV-7) — and the COUNCIL
 * case proves the F-12 ordering (council mint created BEFORE the realm
 * registers it), which the old server orchestrator got wrong.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMint2Instruction,
} from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import type { ProgramTestContext } from "solana-bankrun";
import {
  SQUADS_V4_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  buildLaunchPlan,
  extraSignersFor,
} from "../packages/sdk/src/launch-plan";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import type { CouncilSetup } from "../packages/sdk/src/governance";
import {
  BASE_VOTING_TIME_S,
  SUPPLY,
  TEST_TIMEOUT,
  send,
  squadsConfig,
  startCtx,
} from "./helpers/bankrun-harness";

async function ctxWithStack(): Promise<ProgramTestContext> {
  return startCtx([
    { name: "vsr", programId: VSR_PROGRAM_ID },
    { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
  ]);
}

/** Stand in for pump create_v2: a Token-2022 community mint (mint co-signs). */
async function createTokenIxsFor(
  ctx: ProgramTestContext,
  wallet: PublicKey,
  mint: PublicKey,
) {
  const rent = await ctx.banksClient.getRent();
  const lamports = Number(await rent.minimumBalance(BigInt(MINT_SIZE)));
  return [
    SystemProgram.createAccount({
      fromPubkey: wallet,
      newAccountPubkey: mint,
      lamports,
      space: MINT_SIZE,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(
      mint,
      6,
      wallet,
      null, // mint authority null — mirrors a finalized pump mint (INV-5)
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
}

async function assertStoodUp(ctx: ProgramTestContext, plan: Awaited<ReturnType<typeof buildLaunchPlan>>) {
  expect(await ctx.banksClient.getAccount(plan.treasury.realm)).not.toBeNull();
  expect(await ctx.banksClient.getAccount(plan.treasury.governance)).not.toBeNull();
  expect(
    await ctx.banksClient.getAccount(plan.treasury.nativeTreasury),
  ).not.toBeNull();
  const msInfo = await ctx.banksClient.getAccount(plan.treasury.multisigPda);
  const [ms] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msInfo!.lamports),
    data: Buffer.from(msInfo!.data),
  });
  // INV-7: the multisig's SOLE member is the advance-derived native treasury.
  expect(ms.members.length).toBe(1);
  expect(ms.members[0]!.key.equals(plan.treasury.nativeTreasury)).toBe(true);
}

describe("self-service launch stands up the DAO on the real binaries (no server key)", () => {
  it(
    "cypherpunk: wallet + ephemeral keypairs only",
    async () => {
      const ctx = await ctxWithStack();
      const wallet = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 2_000_000_000,
          }),
        ],
        [],
      );
      const mintKp = Keypair.generate();
      const createKeyKp = Keypair.generate();

      const plan = await buildLaunchPlan({
        launcher: wallet.publicKey,
        mint: mintKp.publicKey,
        createKey: createKeyKp.publicKey,
        mode: "cypherpunk",
        params: resolveGovernanceParams({
          mode: "cypherpunk",
          tier: "micro",
          communitySupply: SUPPLY,
        }),
        createTokenIxs: await createTokenIxsFor(
          ctx,
          wallet.publicKey,
          mintKp.publicKey,
        ),
        programConfigTreasury: new PublicKey(squadsConfig.treasury),
        launchFeeLamports: 0n,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });

      for (const group of plan.groups) {
        const extra = extraSignersFor(group, [mintKp, createKeyKp]);
        await send(ctx, group.instructions, extra, wallet);
      }

      await assertStoodUp(ctx, plan);
    },
    TEST_TIMEOUT,
  );

  it(
    "council: the F-12 order (council mint before realm) executes cleanly",
    async () => {
      const ctx = await ctxWithStack();
      const wallet = Keypair.generate();
      const councilMember = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 2_000_000_000,
          }),
        ],
        [],
      );
      const mintKp = Keypair.generate();
      const createKeyKp = Keypair.generate();
      const councilMintKp = Keypair.generate();
      const rent = await ctx.banksClient.getRent();
      const mintRent = await rent.minimumBalance(BigInt(MINT_SIZE));

      const council: CouncilSetup = {
        mint: councilMintKp.publicKey,
        members: [councilMember.publicKey],
        vetoThresholdPercent: 50,
        mintRentLamports: BigInt(mintRent),
      };

      const plan = await buildLaunchPlan({
        launcher: wallet.publicKey,
        mint: mintKp.publicKey,
        createKey: createKeyKp.publicKey,
        mode: "council",
        params: resolveGovernanceParams({
          mode: "council",
          tier: "micro",
          communitySupply: SUPPLY,
        }),
        createTokenIxs: await createTokenIxsFor(
          ctx,
          wallet.publicKey,
          mintKp.publicKey,
        ),
        programConfigTreasury: new PublicKey(squadsConfig.treasury),
        launchFeeLamports: 0n,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        council,
      });

      // council group must come before the realm group (F-12)
      const labels = plan.groups.map((g) => g.label);
      expect(labels.indexOf("create-dao:council")).toBeLessThan(
        labels.indexOf("create-dao:realm"),
      );

      for (const group of plan.groups) {
        const extra = extraSignersFor(group, [
          mintKp,
          createKeyKp,
          councilMintKp,
        ]);
        await send(ctx, group.instructions, extra, wallet);
      }

      await assertStoodUp(ctx, plan);
    },
    TEST_TIMEOUT,
  );
});
