/**
 * Does devnet's governance stack behave like the one we designed against?
 *
 * It is NOT the same program, and that is easy to miss because the addresses
 * are identical. `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw` on devnet is
 * **spl-governance 3.1.2**, 1,195,568 bytes; on mainnet it is the **3.1.4**
 * fork, 1,319,856 bytes — a different build with functional differences
 * (mainnet carries Token-2022 deposit checks devnet's build has no strings
 * for). Squads v4 differs too, both in binary and in its on-chain
 * ProgramConfig, which names a different authority and treasury.
 *
 * This matters because the whole guarded design rests on ONE property of
 * that fork (D-042): `min_community_weight_to_create_proposal = u64::MAX` is
 * an EXPLICIT "disabled" sentinel rather than a large threshold. If devnet's
 * 3.1.2 treated it as a mere number, a whale there could author proposals and
 * a "successful" live devnet run would be evidence about a program nobody
 * uses in production — the D-031/D-032 mistake wearing a different hat.
 *
 * So before spending anything on a devnet gate deploy, run the load-bearing
 * assertions against the DEVNET binaries in bankrun. Green here means a live
 * devnet run is worth doing and worth believing; red means the run would be
 * theatre and we would have found out for free.
 *
 * Fixtures: tests/fixtures/spl_governance_devnet.so.gz and
 * squads_v4_devnet.so.gz, dumped from devnet with
 * `solana program dump <id> <out> --url devnet`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  Proposal,
  ProposalState,
  Vote,
  VoteChoice,
  VoteKind,
  VoteType,
  withCastVote,
  withCreateProposal,
  withFinalizeVote,
} from "@solana/spl-governance";
import type { ProgramTestContext } from "solana-bankrun";
import {
  PROPOSAL_GATE_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import {
  DEFAULT_GATE_WHITELIST,
  buildCreateGatedProposalIx,
  buildInsertGatedTransactionIx,
  buildSignOffGatedProposalIx,
  gateAuthorityPda,
  gatePda,
  tokenOwnerRecordPda,
} from "../packages/sdk/src/gate";
import {
  BASE_VOTING_TIME_S,
  PROGRAM_VERSION,
  TEST_TIMEOUT,
  createDao,
  readGov,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const FIXTURES = resolve(__dirname, "fixtures");
const inflate = (name: string) =>
  gunzipSync(readFileSync(resolve(FIXTURES, `${name}.so.gz`)));

describe("devnet governance parity — is devnet's stack the one we designed against?", () => {
  let ctx: ProgramTestContext;
  beforeAll(async () => {
    ctx = await startCtx(
      [{ name: "proposal_gate", programId: PROPOSAL_GATE_PROGRAM_ID }],
      [],
      "devnet",
    );
  }, TEST_TIMEOUT);

  it("the two clusters run DIFFERENT governance builds, and this pins which", () => {
    const devnet = inflate("spl_governance_devnet");
    const mainnet = inflate("spl_governance");
    expect(devnet.equals(mainnet)).toBe(false);

    // The version is embedded next to the sign-off processor's path string.
    const version = (b: Buffer) =>
      /process_sign_off_proposal\.rs(3\.\d+\.\d+)/.exec(b.toString("latin1"))?.[1];
    expect(version(devnet)).toBe("3.1.2");
    expect(version(mainnet)).toBe("3.1.4");

    // A concrete functional difference, so "different build" is not just a
    // size claim: mainnet's fork carries Token-2022 deposit validation that
    // devnet's build has no strings for at all.
    const has = (b: Buffer, s: string) => b.toString("latin1").includes(s);
    expect(has(mainnet, "Invalid SPL Token program id")).toBe(true);
    expect(has(devnet, "Invalid SPL Token program id")).toBe(false);

    // But the sentinel the guarded design depends on exists in BOTH. That is
    // necessary, not sufficient — the tests below are the sufficient part.
    expect(has(devnet, "Voter weight threshold disabled")).toBe(true);
    expect(has(mainnet, "Voter weight threshold disabled")).toBe(true);
  });

  it("Squads on devnet is a different build with a different ProgramConfig", () => {
    expect(inflate("squads_v4_devnet").equals(inflate("squads_v4"))).toBe(false);
    const cfg = (f: string) =>
      JSON.parse(readFileSync(resolve(FIXTURES, f), "utf8")) as {
        treasury: string;
        dataBase64: string;
      };
    const dev = cfg("squads-program-config-devnet.json");
    const main = cfg("squads-program-config.json");
    // Same address, different content — the ceremony pays creation fees to
    // whichever treasury the LOCAL config names, so this cannot be assumed.
    expect(dev.treasury).not.toBe(main.treasury);
  });

  it(
    "on DEVNET's 3.1.2, the u64::MAX sentinel still disables authorship — and the gate still works",
    async () => {
      const dao = await createDao(ctx, "guarded");

      // The ceremony itself lands: gate account bound to this realm, guarded
      // mode, full default menu, and the ONE council token in the gate's
      // record. If 3.1.2 rejected any CPI in the ceremony we would fail here.
      const gateInfo = await ctx.banksClient.getAccount(gatePda(dao.realm));
      expect(gateInfo).not.toBeNull();
      const g = Buffer.from(gateInfo!.data);
      expect(new PublicKey(g.subarray(8, 40)).equals(dao.realm)).toBe(true);
      expect(g[136]).toBe(0); // guarded
      expect(g.readUInt32LE(138)).toBe(DEFAULT_GATE_WHITELIST.length);

      const authority = gateAuthorityPda(dao.realm);
      const gateTor = tokenOwnerRecordPda(dao.realm, dao.councilMint!, authority);
      const torInfo = await ctx.banksClient.getAccount(gateTor);
      expect(Buffer.from(torInfo!.data).readBigUInt64LE(97)).toBe(1n);

      // THE load-bearing assertion. The community holder owns the entire
      // supply and is still refused, by the same explicit sentinel error as
      // on 3.1.4 — so guarded mode is not a mainnet-only property.
      const direct: TransactionInstruction[] = [];
      await withCreateProposal(
        direct,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        dao.voterTor,
        "direct",
        "",
        dao.mint,
        dao.voter.publicKey,
        undefined,
        VoteType.SINGLE_CHOICE,
        ["Approve"],
        true,
        dao.voter.publicKey,
      );
      const refusal = await sendExpectFail(ctx, direct, [dao.voter]);
      expect(refusal).toMatch(/voter weight threshold disabled/i);

      // And the front door is open to anyone, with the community as the
      // electorate — create, insert, sign off, vote, finalize, on 3.1.2.
      const proposer = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: proposer.publicKey,
            lamports: 1_000_000_000,
          }),
        ],
        [],
      );
      const made = buildCreateGatedProposalIx({
        proposer: proposer.publicKey,
        realm: dao.realm,
        governance: dao.governance,
        communityMint: dao.mint,
        councilMint: dao.councilMint!,
        name: "devnet parity grant",
        descriptionLink: "hash",
        proposalSeed: Keypair.generate().publicKey,
      });
      await send(ctx, [made.ix], [proposer]);
      await send(
        ctx,
        [
          buildInsertGatedTransactionIx({
            proposer: proposer.publicKey,
            realm: dao.realm,
            governance: dao.governance,
            councilMint: dao.councilMint!,
            proposal: made.proposal,
            index: 0,
            holdUpSeconds: dao.params.holdUpSeconds,
            instructions: [
              SystemProgram.transfer({
                fromPubkey: dao.nativeTreasury,
                toPubkey: proposer.publicKey,
                lamports: 1_000,
              }),
            ],
          }).ix,
        ],
        [proposer],
      );
      await send(
        ctx,
        [
          buildSignOffGatedProposalIx({
            realm: dao.realm,
            governance: dao.governance,
            councilMint: dao.councilMint!,
            proposal: made.proposal,
          }),
        ],
        [],
      );

      const vote: TransactionInstruction[] = [];
      await withCastVote(
        vote,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        gateTor,
        dao.voterTor,
        dao.voter.publicKey,
        dao.mint,
        new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        }),
        ctx.payer.publicKey,
      );
      await send(ctx, vote, [dao.voter]);
      await warpSeconds(ctx, BASE_VOTING_TIME_S + 10);
      const final: TransactionInstruction[] = [];
      await withFinalizeVote(
        final,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        dao.governance,
        made.proposal,
        gateTor,
        dao.mint,
      );
      await send(ctx, final, []);
      expect((await readGov(ctx, made.proposal, Proposal)).state).toBe(
        ProposalState.Succeeded,
      );
    },
    TEST_TIMEOUT,
  );
});
