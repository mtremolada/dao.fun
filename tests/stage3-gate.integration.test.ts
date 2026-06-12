/**
 * proposal-gate v1 against REAL chain state (spec 6.9, D-030): the gate's
 * on-chain validation engine reads ProposalTransactionV2 accounts the
 * production propose path created on the deployed spl-governance binary,
 * unwraps the Squads vaultTransactionCreate message, and:
 *
 *   - clears every leg of a menu (grant) proposal — 4-step custody chain;
 *   - REFUSES a direct leg targeting an off-whitelist program;
 *   - REFUSES a proposal whose INNER vault-signed instruction smuggles an
 *     off-whitelist program inside the Squads message (the hiding spot);
 *   - enforces the INV-11 ratchet structurally: only the governance PDA
 *     (signing through an executed proposal) can move the mode, and only
 *     toward decentralization — the reverse step fails IN THE SAME
 *     proposal after the forward step succeeded.
 *
 * Build pipeline (D-029): the fixture is our own cargo-build-sbf artifact.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { ProposalState } from "@solana/spl-governance";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  castCommunityYes,
  createDao,
  executeIxsFor,
  finalizeAfterVotingWindow,
  proposeInner,
  proposeSweep,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
  type Dao,
} from "./helpers/bankrun-harness";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import type { ProgramTestContext } from "solana-bankrun";

const GATE_PROGRAM_ID = new PublicKey(
  "3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg",
);

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function gatePda(realm: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gate"), realm.toBuffer()],
    GATE_PROGRAM_ID,
  )[0];
}

function clearancePda(pt: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("clearance"), pt.toBuffer()],
    GATE_PROGRAM_ID,
  )[0];
}

function initializeIx(
  dao: Dao,
  payer: PublicKey,
  whitelist: PublicKey[],
): TransactionInstruction {
  const vec = Buffer.alloc(4);
  vec.writeUInt32LE(whitelist.length);
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: gatePda(dao.realm), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("initialize"),
      dao.realm.toBuffer(),
      dao.governance.toBuffer(),
      Buffer.from([0]), // mode: guarded
      vec,
      ...whitelist.map((p) => p.toBuffer()),
    ]),
  });
}

function validateIx(
  dao: Dao,
  pt: PublicKey,
  payer: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: gatePda(dao.realm), isSigner: false, isWritable: false },
      { pubkey: pt, isSigner: false, isWritable: false },
      { pubkey: clearancePda(pt), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("validate_transaction"),
  });
}

function ratchetIx(
  dao: Dao,
  newMode: number,
  governanceIsSigner = true,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: gatePda(dao.realm), isSigner: false, isWritable: true },
      { pubkey: dao.governance, isSigner: governanceIsSigner, isWritable: false },
    ],
    data: Buffer.concat([disc("ratchet"), Buffer.from([newMode])]),
  });
}

async function gateMode(ctx: ProgramTestContext, dao: Dao): Promise<number> {
  const info = await ctx.banksClient.getAccount(gatePda(dao.realm));
  // layout: 8 disc + realm 32 + governance 32 + mode u8 + bump u8 + vec
  return Buffer.from(info!.data)[72]!;
}

describe("Stage 3 proposal-gate v1: on-chain menu validation + structural ratchet (real binaries)", () => {
  it(
    "clears the custody chain, refuses off-menu programs (outer AND inner), and ratchets one-way by vote only",
    async () => {
      const ctx = await startCtx([
        { name: "proposal_gate", programId: GATE_PROGRAM_ID },
      ]);
      const dao = await createDao(ctx, "cypherpunk");
      const whitelist = [
        SystemProgram.programId,
        SQUADS_V4_PROGRAM_ID,
        SPL_GOVERNANCE_PROGRAM_ID,
      ];
      await send(ctx, [initializeIx(dao, ctx.payer.publicKey, whitelist)], []);
      expect(await gateMode(ctx, dao)).toBe(0); // guarded
      // the gate config is immutable: re-initialization is refused
      expect(
        await sendExpectFail(
          ctx,
          [initializeIx(dao, ctx.payer.publicKey, whitelist)],
          [],
        ),
      ).toMatch(/already in use|custom program error/i);

      // ===== a menu proposal (grant through the custody chain) clears =====
      const grant = await proposeSweep(ctx, dao, 0);
      expect(grant.ptAddrs).toHaveLength(4);
      for (const pt of grant.ptAddrs) {
        await send(ctx, [validateIx(dao, pt, ctx.payer.publicKey)], []);
        const clearance = await ctx.banksClient.getAccount(clearancePda(pt));
        expect(clearance).not.toBeNull();
        expect(
          new PublicKey(Buffer.from(clearance!.data).subarray(8, 40)).equals(
            grant.proposal,
          ),
        ).toBe(true);
      }

      // ===== an off-menu DIRECT leg is refused =====
      const foreignProgram = Keypair.generate().publicKey;
      const offMenuDirect = await proposeInner(
        ctx,
        dao,
        1,
        [],
        "off-menu direct",
        [
          new TransactionInstruction({
            programId: foreignProgram,
            keys: [],
            data: Buffer.from([1, 2, 3]),
          }),
        ],
      );
      expect(
        await sendExpectFail(
          ctx,
          [validateIx(dao, offMenuDirect.ptAddrs[0]!, ctx.payer.publicKey)],
          [],
        ),
      ).toMatch(/outside the gate whitelist/i);

      // ===== an off-menu INNER instruction (inside the Squads message)
      // is refused — the on-chain unwrap works =====
      const smuggled = await proposeInner(
        ctx,
        dao,
        2,
        [
          new TransactionInstruction({
            programId: foreignProgram,
            keys: [],
            data: Buffer.from([9]),
          }),
        ],
        "smuggled inner",
      );
      // ptAddrs[0] is the vaultTransactionCreate leg carrying the message
      expect(
        await sendExpectFail(
          ctx,
          [validateIx(dao, smuggled.ptAddrs[0]!, ctx.payer.publicKey)],
          [],
        ),
      ).toMatch(/outside the gate whitelist/i);
      // ...while its OTHER chain legs (pure Squads plumbing) clear fine
      await send(
        ctx,
        [validateIx(dao, smuggled.ptAddrs[1]!, ctx.payer.publicKey)],
        [],
      );

      // ===== INV-11 ratchet =====
      // nobody can fake the governance signature outside an executed proposal
      expect(
        await sendExpectFail(ctx, [ratchetIx(dao, 2, false)], []),
      ).toMatch(/custom program error|Signer|signature/i);

      // by vote: forward (guarded 0 -> cypherpunk 2) succeeds, and the
      // SAME proposal's second leg back to council(1) is refused
      const ratchetProposal = await proposeInner(
        ctx,
        dao,
        3,
        [],
        "ratchet to cypherpunk, then illegally back",
        [ratchetIx(dao, 2), ratchetIx(dao, 1)],
      );
      await castCommunityYes(ctx, dao, ratchetProposal.proposal);
      expect(
        await finalizeAfterVotingWindow(ctx, dao, ratchetProposal.proposal),
      ).toBe(ProposalState.Succeeded);
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await send(ctx, await executeIxsFor(dao, ratchetProposal, 0), []);
      expect(await gateMode(ctx, dao)).toBe(2); // cypherpunk
      expect(
        await sendExpectFail(ctx, await executeIxsFor(dao, ratchetProposal, 1), []),
      ).toMatch(/one-way toward decentralization|custom program error/i);
      expect(await gateMode(ctx, dao)).toBe(2); // unchanged
    },
    TEST_TIMEOUT,
  );
});
