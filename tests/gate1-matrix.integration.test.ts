/**
 * GATE 1 mode matrix — council, cypherpunk, and VSR legs (spec 13.8).
 *
 * Runs the REAL mainnet program binaries in solana-bankrun via the shared
 * harness, driving the SAME sdk builders the launch flow uses. Clock
 * control gives the assertions a live cluster cannot:
 *
 * - council leg: a council veto moves the proposal to Vetoed and execution
 *   is refused (INV-4); a NON-vetoed proposal on the same DAO executes —
 *   but only after the 72h micro-tier hold-up has elapsed (INV-3).
 * - cypherpunk leg: the realm is built with NO council accounts
 *   (structural, spec 12.2), the 72h hold-up gates execution (INV-3),
 *   and the full Squads custody chain moves the vault's lamports.
 * - VSR leg: baseline-0 lockup weighting incl. clock-warp decay, plus the
 *   D-013 re-verification (Token-2022 rejected by create_registrar).
 * - all legs: the instruction-set hash recomputed from the on-chain
 *   ProposalTransactions matches the published artifact hash (INV-9).
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  InstructionExecutionStatus,
  Proposal,
  ProposalState,
  ProposalTransaction,
  Realm,
  VoteType,
  getTokenOwnerRecordAddress,
  withCreateProposal,
  withCreateTokenOwnerRecord,
} from "@solana/spl-governance";
import { start } from "solana-bankrun";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  LockupKind,
  buildCreateDepositEntryIx,
  buildCreateVoterIx,
  buildDepositIx,
  buildUpdateVoterWeightRecordIx,
} from "../packages/sdk/src/vsr";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import {
  BASE_VOTING_TIME_S,
  MICRO_HOLDUP_S,
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  VAULT_FUND,
  balance,
  castCommunityYes,
  castCouncilVeto,
  chainHashOf,
  createDao,
  executeAll,
  executeIxsFor,
  finalizeAfterVotingWindow,
  mintRent,
  proposeSweep,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

// ---------- the legs ----------

describe("GATE 1 council leg (real binaries, bankrun)", () => {
  it(
    "council veto moves the proposal to Vetoed and execution is refused (INV-4); a non-vetoed proposal executes only after the 72h hold-up (INV-3); INV-9 holds",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "council");
      expect(dao.params.vetoEnabled).toBe(true);
      expect(dao.params.holdUpSeconds).toBe(MICRO_HOLDUP_S);

      // --- proposal 0: community YES, council VETO -> Vetoed, no execution
      const vetoed = await proposeSweep(ctx, dao, 0);
      expect(await chainHashOf(ctx, vetoed)).toBe(vetoed.innerHash); // INV-9
      await castCommunityYes(ctx, dao, vetoed.proposal);
      await castCouncilVeto(ctx, dao, vetoed.proposal);
      expect((await readGov(ctx, vetoed.proposal, Proposal)).state).toBe(
        ProposalState.Vetoed,
      );
      // Even after every timer has elapsed, a vetoed proposal cannot execute.
      await warpSeconds(ctx, BASE_VOTING_TIME_S + MICRO_HOLDUP_S + 20);
      const vetoErr = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, vetoed, 0),
        [],
      );
      expect(vetoErr).toMatch(/invalid|cannot execute/i);
      expect(await balance(ctx, vetoed.recipient)).toBe(0);
      expect(await balance(ctx, dao.vaultPda)).toBe(VAULT_FUND);

      // --- proposal 1: community YES, NO veto -> executes after hold-up
      const passed = await proposeSweep(ctx, dao, 1);
      expect(await chainHashOf(ctx, passed)).toBe(passed.innerHash); // INV-9
      await castCommunityYes(ctx, dao, passed.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, passed.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // INV-3: before the hold-up elapses, execution is refused.
      const early = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, passed, 0),
        [],
      );
      expect(early).toMatch(/hold up time/i);

      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, passed);

      for (const addr of passed.ptAddrs) {
        const pt = await readGov(ctx, addr, ProposalTransaction);
        expect(pt.executionStatus).toBe(InstructionExecutionStatus.Success);
      }
      expect(await balance(ctx, dao.vaultPda)).toBe(0);
      expect(await balance(ctx, passed.recipient)).toBe(VAULT_FUND);
    },
    TEST_TIMEOUT,
  );
});

describe("GATE 1 VSR leg — lockup-weighted vote power under clock warp (real binaries, bankrun)", () => {
  it(
    "unlocked deposits carry ZERO weight (cannot propose); a cliff lockup carries full weight that decays as the clock advances (spec 6.3)",
    async () => {
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
        ],
        [],
      );
      const payer = ctx.payer;
      const voter = Keypair.generate();
      const mint = Keypair.generate();
      const rentLamports = Number(await mintRent(ctx));
      const voterAta = getAssociatedTokenAddressSync(mint.publicKey, voter.publicKey);

      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: voter.publicKey,
            lamports: 1_000_000_000,
          }),
          SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mint.publicKey,
            lamports: rentLamports,
            space: MINT_SIZE,
            programId: TOKEN_PROGRAM_ID,
          }),
          createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            voterAta,
            voter.publicKey,
            mint.publicKey,
          ),
          createMintToInstruction(mint.publicKey, voterAta, payer.publicKey, SUPPLY),
        ],
        [mint],
      );

      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      // Realm WITH the VSR addin this time (classic SPL mint, so the
      // deployed program accepts it — the D-013 restriction is Token-2022).
      const dao = await buildCreateDaoIxs({
        mint: mint.publicKey,
        payer: payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });
      await send(ctx, dao.groups.realmSetup, []);
      await send(ctx, dao.groups.governanceSetup, []);

      // VSR voter accounts + a spl-governance TOR (deposits live in VSR;
      // the record anchors proposals/votes).
      const created = buildCreateVoterIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
      });
      const torIxs: TransactionInstruction[] = [];
      await withCreateTokenOwnerRecord(
        torIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voter.publicKey,
        mint.publicKey,
        payer.publicKey,
      );
      await send(ctx, [created.ix, ...torIxs], [voter]);
      const voterTor = await getTokenOwnerRecordAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        dao.realm,
        mint.publicKey,
        voter.publicKey,
      );

      const readWeight = async (): Promise<bigint> => {
        await send(
          ctx,
          [
            buildUpdateVoterWeightRecordIx({
              registrar: dao.registrar,
              voterAuthority: voter.publicKey,
            }),
          ],
          [],
        );
        const info = await ctx.banksClient.getAccount(created.voterWeightRecord);
        // VoterWeightRecord: 8 disc + realm 32 + mint 32 + owner 32, then
        // voter_weight u64 LE.
        return Buffer.from(info!.data).readBigUInt64LE(104);
      };

      // --- unlocked deposit: baseline weight 0 -> no proposal power
      const half = SUPPLY / 2n;
      const unlocked = buildCreateDepositEntryIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
        depositMint: mint.publicKey,
        depositEntryIndex: 0,
        kind: LockupKind.None,
        periods: 0,
        allowClawback: false,
      });
      await send(
        ctx,
        [
          unlocked.ix,
          buildDepositIx({
            registrar: dao.registrar,
            voterAuthority: voter.publicKey,
            vault: unlocked.vault,
            depositToken: voterAta,
            depositEntryIndex: 0,
            amount: half,
          }),
        ],
        [voter],
      );
      expect(await readWeight()).toBe(0n);

      // Proposal creation is refused: zero weight < the 2% threshold.
      // (VSR weight expires after the recording slot — update in the same tx.)
      const failIxs: TransactionInstruction[] = [
        buildUpdateVoterWeightRecordIx({
          registrar: dao.registrar,
          voterAuthority: voter.publicKey,
        }),
      ];
      await withCreateProposal(
        failIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        voterTor,
        "unlocked tokens cannot propose",
        "",
        mint.publicKey,
        voter.publicKey,
        0,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        payer.publicKey,
        created.voterWeightRecord,
      );
      const refused = await sendExpectFail(ctx, failIxs, [voter]);
      expect(refused).toMatch(/enough governing tokens|TokenOwnerRecord/i);

      // --- cliff lockup at the saturation horizon: full weight
      const cliff = buildCreateDepositEntryIx({
        registrar: dao.registrar,
        voterAuthority: voter.publicKey,
        payer: payer.publicKey,
        depositMint: mint.publicKey,
        depositEntryIndex: 1,
        kind: LockupKind.Cliff,
        periods: 365, // days == micro-tier lockupSaturationSeconds
        allowClawback: false,
      });
      await send(
        ctx,
        [
          cliff.ix,
          buildDepositIx({
            registrar: dao.registrar,
            voterAuthority: voter.publicKey,
            vault: cliff.vault,
            depositToken: voterAta,
            depositEntryIndex: 1,
            amount: half,
          }),
        ],
        [voter],
      );
      const lockedWeight = await readWeight();
      expect(lockedWeight).toBe(half); // saturated lockup -> 1.0x, unlocked half still 0

      // ...and with weight, proposing now succeeds.
      const okIxs: TransactionInstruction[] = [
        buildUpdateVoterWeightRecordIx({
          registrar: dao.registrar,
          voterAuthority: voter.publicKey,
        }),
      ];
      await withCreateProposal(
        okIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        voterTor,
        "locked tokens can propose",
        "",
        mint.publicKey,
        voter.publicKey,
        0,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        payer.publicKey,
        created.voterWeightRecord,
      );
      await send(ctx, okIxs, [voter]);

      // --- clock warp: cliff weight decays linearly toward expiry
      await warpSeconds(ctx, Math.floor((365 * 86400) / 2));
      const decayed = await readWeight();
      // Half the saturation horizon remains -> ~half the weight (loose
      // bounds absorb the day-granularity rounding of cliff lockups).
      expect(decayed).toBeGreaterThan((half * 45n) / 100n);
      expect(decayed).toBeLessThan((half * 55n) / 100n);

      // ...and past the cliff, lockup weight is gone entirely.
      await warpSeconds(ctx, Math.ceil((365 * 86400) / 2) + 86400);
      expect(await readWeight()).toBe(0n);
    },
    TEST_TIMEOUT,
  );

  it(
    "re-verifies D-013 with CORRECT registrar seeds: create_registrar rejects a Token-2022 community mint",
    async () => {
      // The mainnet D-013 attempt used the (then-wrong) literal-first
      // registrar seeds, so its failure proved nothing about Token-2022.
      // This is the clean experiment against the real binary.
      const ctx = await start(
        [
          { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
          { name: "vsr", programId: VSR_PROGRAM_ID },
          { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
        ],
        [],
      );
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

      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      const dao = await buildCreateDaoIxs({
        mint: mint.publicKey,
        payer: payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
      });
      // realmSetup = [createRealm, createRegistrar, configureVotingMint];
      // the realm itself accepts Token-2022 with the D-013 token-program
      // retarget (proven live on mainnet) — send it alone, then expect the
      // registrar creation to fail on the mint's owner, NOT on seeds.
      const [createRealmIx, createRegistrarIx] = dao.groups.realmSetup;
      const retargeted = new TransactionInstruction({
        programId: createRealmIx!.programId,
        data: createRealmIx!.data,
        keys: createRealmIx!.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID)
            ? { ...k, pubkey: TOKEN_2022_PROGRAM_ID }
            : k,
        ),
      });
      await send(ctx, [retargeted], []);
      const err = await sendExpectFail(ctx, [createRegistrarIx!], []);
      expect(err).not.toMatch(/privilege escalated/i);
      expect(err).toMatch(/AccountOwnedByWrongProgram|owned by a different program|InvalidProgramId/i);
    },
    TEST_TIMEOUT,
  );
});

describe("GATE 1 cypherpunk leg (real binaries, bankrun)", () => {
  it(
    "the realm has NO council accounts (structural), the 72h hold-up gates execution (INV-3), and the custody chain moves the vault funds; INV-9 holds",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");
      expect(dao.params.vetoEnabled).toBe(false);
      expect(dao.params.holdUpSeconds).toBe(MICRO_HOLDUP_S); // max(24h, micro floor)
      expect(dao.councilMint).toBeNull();

      // Structural no-veto: the realm itself has no council mint registered.
      const realm = await readGov(ctx, dao.realm, Realm);
      expect(realm.config.councilMint).toBeUndefined();

      const made = await proposeSweep(ctx, dao, 0);
      expect(await chainHashOf(ctx, made)).toBe(made.innerHash); // INV-9
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // INV-3: refused before the hold-up has elapsed...
      const early = await sendExpectFail(
        ctx,
        await executeIxsFor(dao, made, 0),
        [],
      );
      expect(early).toMatch(/hold up time/i);
      expect(await balance(ctx, dao.vaultPda)).toBe(VAULT_FUND);

      // ...and the full Squads chain executes once it has.
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      expect(await balance(ctx, dao.vaultPda)).toBe(0);
      expect(await balance(ctx, made.recipient)).toBe(VAULT_FUND);
      expect((await readGov(ctx, made.proposal, Proposal)).state).toBe(
        ProposalState.Completed,
      );
    },
    TEST_TIMEOUT,
  );
});

