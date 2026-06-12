/**
 * Stage 3 build pipeline (spec 6.9 / GATE 3 path): OUR OWN compiled
 * program — programs/proposal-gate built with cargo build-sbf
 * (platform-tools v1.53, anchor-lang 0.30.1, overflow-checks=on at the
 * workspace level) — loads and executes in the same bankrun harness the
 * deployed-binary suites use. The fixture proposal_gate.so.gz is the
 * committed artifact; rebuild with:
 *
 *   cargo build-sbf --manifest-path programs/proposal-gate/Cargo.toml
 *   gzip -c programs/target/deploy/proposal_gate.so > tests/fixtures/proposal_gate.so.gz
 *
 * The instruction layer is exercised the same way the VSR/D-010 builders
 * are: manual anchor discriminators against the declared layout.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TEST_TIMEOUT,
  send,
  sendExpectFail,
  startCtx,
} from "./helpers/bankrun-harness";

const PROPOSAL_GATE_PROGRAM_ID = new PublicKey(
  "3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg",
);

function anchorIxDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function anchorAccountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

describe("Stage 3 scaffold: our own anchor program builds, loads and executes (bankrun)", () => {
  it(
    "initialize creates the gate PDA with the declared layout; re-init is refused",
    async () => {
      const ctx = await startCtx([
        { name: "proposal_gate", programId: PROPOSAL_GATE_PROGRAM_ID },
      ]);
      const realm = Keypair.generate().publicKey;
      const [gate, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("gate"), realm.toBuffer()],
        PROPOSAL_GATE_PROGRAM_ID,
      );
      const ix = new TransactionInstruction({
        programId: PROPOSAL_GATE_PROGRAM_ID,
        keys: [
          { pubkey: gate, isSigner: false, isWritable: true },
          { pubkey: ctx.payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([
          anchorIxDiscriminator("initialize"),
          realm.toBuffer(),
        ]),
      });
      await send(ctx, [ix], []);

      // account layout: 8-byte discriminator + realm pubkey + bump
      const info = await ctx.banksClient.getAccount(gate);
      expect(info).not.toBeNull();
      expect(new PublicKey(info!.owner).equals(PROPOSAL_GATE_PROGRAM_ID)).toBe(
        true,
      );
      const data = Buffer.from(info!.data);
      expect(data.length).toBe(8 + 32 + 1);
      expect(data.subarray(0, 8).equals(anchorAccountDiscriminator("Gate"))).toBe(
        true,
      );
      expect(new PublicKey(data.subarray(8, 40)).equals(realm)).toBe(true);
      expect(data[40]).toBe(bump);

      // anchor `init` refuses a second initialization (account in use)
      expect(await sendExpectFail(ctx, [ix], [])).toMatch(
        /already in use|custom program error/i,
      );
    },
    TEST_TIMEOUT,
  );
});
