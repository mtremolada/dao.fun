/**
 * AUDIT F-1 (HIGH) — the launch orchestrator must stand up a DAO for the
 * Token-2022 mints the launchpad always creates. This GUARDS THE FIX.
 *
 * Root cause (pre-fix): `packages/backend/src/launch-steps.ts`
 * (`buildLaunchSteps`) called `buildCreateDaoIxs` with no
 * `communityTokenProgram`, so it defaulted to the VSR addin and the CLASSIC
 * Token program on the community holding account — both invalid for a
 * Token-2022 mint (D-004/D-013/D-018). The create-dao step's realmSetup
 * reverted on-chain.
 *
 * Fix: `buildCreateDaoIxs` now takes `communityTokenProgram`; for Token-2022 it
 * drops the VSR addin, retargets the realm/governance token program, and mints
 * the council token under Token-2022 (one token program for both holding
 * accounts). `buildLaunchSteps` passes TOKEN_2022_PROGRAM_ID.
 *
 * These tests run the FIXED builder output on the deployed binaries and prove
 * the full create-dao sequence executes — and pin that the legacy default
 * (classic program) still fails, so the adaptation cannot be silently dropped.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMint2Instruction,
} from "@solana/spl-token";
import { start, type ProgramTestContext } from "solana-bankrun";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import {
  BASE_VOTING_TIME_S,
  SUPPLY,
  TEST_TIMEOUT,
  send,
  sendExpectFail,
} from "./helpers/bankrun-harness";

async function ctxWithGov(): Promise<ProgramTestContext> {
  return start(
    [
      { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
      { name: "vsr", programId: VSR_PROGRAM_ID },
      { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
    ],
    [],
  );
}

async function token2022Mint(ctx: ProgramTestContext): Promise<PublicKey> {
  const mint = Keypair.generate();
  const rent = await ctx.banksClient.getRent();
  const lamports = Number(await rent.minimumBalance(BigInt(MINT_SIZE)));
  await send(
    ctx,
    [
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        ctx.payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [mint],
  );
  return mint.publicKey;
}

describe("AUDIT F-1 (fixed): launch orchestrator stands up a Token-2022 DAO (real binaries)", () => {
  it(
    "cypherpunk: the orchestrator's Token-2022 builder call executes realmSetup + governanceSetup",
    async () => {
      const ctx = await ctxWithGov();
      const mint = await token2022Mint(ctx);
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });

      // Exactly what buildLaunchSteps now passes.
      const dao = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        communityTokenProgram: TOKEN_2022_PROGRAM_ID,
      });

      // VSR addin auto-dropped: realmSetup is a lone createRealm, no VSR ix.
      expect(dao.groups.realmSetup.length).toBe(1);
      expect(
        dao.groups.realmSetup.some((ix) => ix.programId.equals(VSR_PROGRAM_ID)),
      ).toBe(false);

      // The full DAO-creation sequence executes on the deployed binaries.
      await send(ctx, dao.groups.realmSetup, []);
      await send(ctx, dao.groups.governanceSetup, []);

      const realmInfo = await ctx.banksClient.getAccount(dao.realm);
      expect(realmInfo).not.toBeNull();
      expect(
        new PublicKey(realmInfo!.owner).equals(SPL_GOVERNANCE_PROGRAM_ID),
      ).toBe(true);
      const govInfo = await ctx.banksClient.getAccount(dao.governance);
      expect(govInfo).not.toBeNull();
      const treasuryInfo = await ctx.banksClient.getAccount(dao.nativeTreasury);
      expect(treasuryInfo).not.toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "council: a Token-2022 council mint + realm + governance sequence executes",
    async () => {
      const ctx = await ctxWithGov();
      const mint = await token2022Mint(ctx);
      const councilMember = Keypair.generate();
      const councilMint = Keypair.generate();
      const rent = await ctx.banksClient.getRent();
      const mintRent = await rent.minimumBalance(BigInt(MINT_SIZE));
      await send(ctx, [
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: councilMember.publicKey,
          lamports: 1_000_000_000,
        }),
      ], []);

      const params = resolveGovernanceParams({
        mode: "council",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      const dao = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "council",
        params,
        council: {
          mint: councilMint.publicKey,
          members: [councilMember.publicKey],
          vetoThresholdPercent: 50,
          mintRentLamports: mintRent,
        },
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        communityTokenProgram: TOKEN_2022_PROGRAM_ID,
      });

      // The council mint is initialized under Token-2022 (same program as
      // both holding accounts) — InitializeMint2 targets the token program.
      expect(dao.groups.council[1]!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(
        true,
      );

      // council first (registers the mint), then realm, then governance.
      await send(ctx, dao.groups.council, [councilMint]);
      await send(ctx, dao.groups.realmSetup, []);
      await send(ctx, dao.groups.governanceSetup, []);

      const realmInfo = await ctx.banksClient.getAccount(dao.realm);
      expect(realmInfo).not.toBeNull();
      const govInfo = await ctx.banksClient.getAccount(dao.governance);
      expect(govInfo).not.toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "regression guard: the legacy default (classic token program) still fails for a Token-2022 mint",
    async () => {
      const ctx = await ctxWithGov();
      const mint = await token2022Mint(ctx);
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });

      // The pre-fix call: no communityTokenProgram -> default classic + VSR.
      const legacy = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });
      expect(legacy.groups.realmSetup.length).toBeGreaterThan(1); // VSR present
      const err: string = await sendExpectFail(
        ctx,
        legacy.groups.realmSetup,
        [],
      );
      expect(err.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});
