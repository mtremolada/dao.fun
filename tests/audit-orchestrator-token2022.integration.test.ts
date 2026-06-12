/**
 * AUDIT F-1 (HIGH) — the production launch ORCHESTRATOR cannot stand up a DAO
 * for the Token-2022 mints the launchpad always creates.
 *
 * `packages/backend/src/launch-steps.ts` (`buildLaunchSteps`, spec 6.6 — the
 * product's real launch API) runs its `create-dao` step by calling
 * `buildCreateDaoIxs({ mint, payer, mode, params, council? })` with NO
 * `communityVoterWeightAddin` and NO token-program retarget. That defaults to:
 *
 *   (a) the VSR addin (governance.ts: undefined -> VSR_PROGRAM_ID), so
 *       `realmSetup` carries create_registrar / configure_voting_mint; and
 *   (b) the CLASSIC SPL Token program on the community-mint holding account
 *       (the 0.3.28 `withCreateRealm` hardcodes TOKEN_PROGRAM_ID).
 *
 * But every pump `create_v2` mint is Token-2022 (D-004), and the deployed VSR
 * rejects Token-2022 (D-013/D-018). D-013 records that "production launch path
 * must use the no-addin realm"; the only launch code ever run against the real
 * binaries — scripts/mainnet-gate1-sovereign*.ts — applies BOTH adaptations
 * (`communityVoterWeightAddin: null` + `retargetTokenProgram`). The backend
 * orchestrator applies NEITHER, and its `create-dao` step is only unit-tested
 * offline, so the omission is never executed against a real binary.
 *
 * Consequence: a real launch via the backend creates the token first
 * (create-token: creator = vault, INV-1), then FAILS at create-dao — leaving a
 * live token whose governance chain can never be stood up through the product.
 *
 * This test reproduces the failure on the deployed binaries and pins the
 * script-proven adaptation as the fix.
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
} from "@solana/spl-token";
import { start } from "solana-bankrun";
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

// Mirror of scripts/mainnet-gate1-sovereign-p2.ts:retargetTokenProgram — the
// Token-2022 adaptation the orchestrator is missing.
function retargetTokenProgram(
  ixs: TransactionInstruction[],
): TransactionInstruction[] {
  return ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID)
            ? { ...k, pubkey: TOKEN_2022_PROGRAM_ID }
            : k,
        ),
      }),
  );
}

async function token2022Mint(ctx: Awaited<ReturnType<typeof start>>) {
  const payer = ctx.payer;
  const mint = Keypair.generate();
  const rent = await ctx.banksClient.getRent();
  const lamports = Number(await rent.minimumBalance(BigInt(MINT_SIZE)));
  await send(
    ctx,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [mint],
  );
  return mint.publicKey;
}

describe("AUDIT F-1: launch orchestrator vs Token-2022 community mint (real binaries)", () => {
  it(
    "the orchestrator's exact buildCreateDaoIxs call produces a realmSetup that CANNOT execute for a Token-2022 mint",
    async () => {
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
          { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
        ],
        [],
      );
      const mint = await token2022Mint(ctx);
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });

      // EXACTLY what packages/backend/src/launch-steps.ts emits in create-dao:
      // no communityVoterWeightAddin, no retarget.
      const orchestrator = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });

      // It defaults to the VSR addin: realmSetup is [createRealm,
      // createRegistrar, configureVotingMint], not a lone createRealm.
      expect(orchestrator.groups.realmSetup.length).toBeGreaterThan(1);
      expect(
        orchestrator.groups.realmSetup.some((ix) =>
          ix.programId.equals(VSR_PROGRAM_ID),
        ),
      ).toBe(true);

      // Sending the orchestrator's realmSetup AS-IS fails on the real binaries.
      const err = await sendExpectFail(ctx, orchestrator.groups.realmSetup, []);
      expect(err).toMatch(
        /AccountOwnedByWrongProgram|owned by a different program|InvalidProgramId|incorrect program id|insufficient account/i,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "even with the VSR addin dropped, the un-retargeted createRealm still fails (the second missing adaptation)",
    async () => {
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
          { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
        ],
        [],
      );
      const mint = await token2022Mint(ctx);
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });

      // Half the fix: drop the addin (D-013) but forget the token-program
      // retarget the mainnet scripts apply. realmSetup is now just createRealm.
      const noAddin = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        communityVoterWeightAddin: null,
      });
      expect(noAddin.groups.realmSetup.length).toBe(1); // createRealm only

      const err = await sendExpectFail(ctx, noAddin.groups.realmSetup, []);
      expect(err.length).toBeGreaterThan(0); // classic token program on a T22 mint
    },
    TEST_TIMEOUT,
  );

  it(
    "the script-proven adaptation (null addin + retargetTokenProgram) DOES stand up the realm",
    async () => {
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
          { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
        ],
        [],
      );
      const mint = await token2022Mint(ctx);
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });

      const fixed = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        communityVoterWeightAddin: null, // D-013 (a)
      });
      // D-013 (b): retarget the classic token program to Token-2022.
      await send(ctx, retargetTokenProgram(fixed.groups.realmSetup), []);

      // The realm now exists at the advance-derived address, owned by
      // spl-governance.
      const info = await ctx.banksClient.getAccount(fixed.realm);
      expect(info).not.toBeNull();
      expect(new PublicKey(info!.owner).equals(SPL_GOVERNANCE_PROGRAM_ID)).toBe(
        true,
      );
    },
    TEST_TIMEOUT,
  );
});
