/**
 * Spec 6.4 — ExecutionAdapter unit tests (written before implementation).
 *
 * The full path (insert into a proposal -> vote -> warp past hold-up ->
 * execute -> vault delta) is the Stage 1 integration suite on a validator
 * with cloned programs; CU measurement and oversized-set splitting live
 * there too. Here: structure, member plumbing, and the wrap/unwrap
 * round-trip the decoder depends on (INV-9/10 support).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { SQUADS_V4_PROGRAM_ID } from "../src/constants";
import {
  unwrap,
  wrap,
  wrapBuffered,
  type WrapContext,
} from "../src/execution-adapter";
import { deriveTreasuryPdas } from "../src/treasury";

const createKey = Keypair.generate().publicKey;
const { multisigPda, vaultPda } = deriveTreasuryPdas(createKey);
const nativeTreasury = Keypair.generate().publicKey; // sole member (INV-7)

const ctx: WrapContext = {
  multisigPda,
  vaultIndex: 0,
  transactionIndex: 1n,
  member: nativeTreasury,
};

function innerTransfers(): ReturnType<typeof SystemProgram.transfer>[] {
  return [
    SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: Keypair.generate().publicKey,
      lamports: 123_456,
    }),
    SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: Keypair.generate().publicKey,
      lamports: 789,
    }),
  ];
}

describe("wrap (spec 6.4)", () => {
  it("produces the 4-step Squads chain in execution order, one ix per ProposalTransaction", () => {
    const ixs = wrap(innerTransfers(), ctx);
    expect(ixs).toHaveLength(4);
    for (const ix of ixs) {
      expect(ix.programId.equals(SQUADS_V4_PROGRAM_ID)).toBe(true);
    }
    // discriminators: create, proposalCreate, approve, execute
    const disc = (i: number) => ixs[i]!.data.subarray(0, 8);
    expect(disc(0)).toEqual(
      Buffer.from(multisig.generated.vaultTransactionCreateInstructionDiscriminator),
    );
    expect(disc(1)).toEqual(
      Buffer.from(multisig.generated.proposalCreateInstructionDiscriminator),
    );
    expect(disc(2)).toEqual(
      Buffer.from(multisig.generated.proposalApproveInstructionDiscriminator),
    );
    expect(disc(3)).toEqual(
      Buffer.from(multisig.generated.vaultTransactionExecuteInstructionDiscriminator),
    );
  });

  it("the native-treasury member is the signer on every step (it signs via SPL-Gov invoke_signed)", () => {
    const ixs = wrap(innerTransfers(), ctx);
    for (const ix of ixs) {
      const memberMeta = ix.keys.find((k) => k.pubkey.equals(nativeTreasury));
      expect(memberMeta, "member must appear in every step").toBeDefined();
      expect(memberMeta!.isSigner).toBe(true);
    }
  });

  it("execute carries the inner accounts; the vault PDA is never marked signer", () => {
    const inner = innerTransfers();
    const ixs = wrap(inner, ctx);
    const execute = ixs[3]!;
    const keys = execute.keys.map((k) => k.pubkey.toBase58());
    for (const ix of inner) {
      for (const meta of ix.keys) {
        expect(keys).toContain(meta.pubkey.toBase58());
      }
      expect(keys).toContain(ix.programId.toBase58());
    }
    const vaultMeta = execute.keys.find((k) => k.pubkey.equals(vaultPda));
    expect(vaultMeta).toBeDefined();
    expect(vaultMeta!.isSigner).toBe(false); // PDA cannot pre-sign
  });

  it("rejects an empty inner set", () => {
    expect(() => wrap([], ctx)).toThrow(/empty/i);
  });
});

describe("unwrap (decoder seam, INV-10)", () => {
  it("round-trips: unwrap(wrap(x)) == x", () => {
    const inner = innerTransfers();
    const out = unwrap(wrap(inner, ctx), ctx);
    expect(out).toHaveLength(inner.length);
    for (let i = 0; i < inner.length; i++) {
      expect(out[i]!.programId.equals(inner[i]!.programId)).toBe(true);
      expect(Buffer.from(out[i]!.data)).toEqual(Buffer.from(inner[i]!.data));
      expect(out[i]!.keys).toHaveLength(inner[i]!.keys.length);
      for (let k = 0; k < inner[i]!.keys.length; k++) {
        expect(out[i]!.keys[k]!.pubkey.equals(inner[i]!.keys[k]!.pubkey)).toBe(true);
        expect(out[i]!.keys[k]!.isWritable).toBe(inner[i]!.keys[k]!.isWritable);
      }
    }
  });

  it("exposes the real inner effects, not the Squads plumbing", () => {
    const inner = innerTransfers();
    const out = unwrap(wrap(inner, ctx), ctx);
    for (const ix of out) {
      expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
      expect(ix.programId.equals(SQUADS_V4_PROGRAM_ID)).toBe(false);
    }
  });

  it("throws when no vaultTransactionCreate is present", () => {
    const ixs = wrap(innerTransfers(), ctx);
    expect(() => unwrap([ixs[1]!, ixs[2]!], ctx)).toThrow(/vaultTransactionCreate/);
  });
});

describe("wrapBuffered (account-heavy inner sets, spec 6.4 size split)", () => {
  // A 19-account instruction (like pump's updateFeeShares) makes the plain
  // wrap's VaultTransactionCreate too large for the 1232-byte governance
  // InsertTransaction. Buffered wrapping chunks the vault message through
  // Squads transaction buffers instead.
  function heavyInner(): TransactionInstruction[] {
    return [
      new TransactionInstruction({
        programId: Keypair.generate().publicKey,
        keys: Array.from({ length: 19 }, (_, i) => ({
          pubkey: Keypair.generate().publicKey,
          isSigner: i === 2,
          isWritable: i % 3 === 0,
        })),
        data: Buffer.alloc(80, 7),
      }),
    ];
  }

  it("chunks reassemble to the exact vault message; hash and size in the create args match", () => {
    const ctxArgs = ctx;
    const result = wrapBuffered(heavyInner(), ctxArgs, 300);
    const [decoded] = multisig.generated.transactionBufferCreateStruct.deserialize(
      result.ixs[0]!.data,
    );
    const chunks = [Buffer.from(decoded.args.buffer as Uint8Array)];
    for (const ix of result.ixs.slice(1, 1 + result.extendCount)) {
      const [ext] = multisig.generated.transactionBufferExtendStruct.deserialize(ix.data);
      chunks.push(Buffer.from(ext.args.buffer as Uint8Array));
    }
    const reassembled = Buffer.concat(chunks);
    expect(reassembled.length).toBe(decoded.args.finalBufferSize);
    expect(
      createHash("sha256").update(reassembled).digest("hex"),
    ).toBe(Buffer.from(decoded.args.finalBufferHash).toString("hex"));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(result.extendCount).toBeGreaterThan(0);
  });

  it("every governance-inserted ix stays under the insert budget that broke the plain wrap", () => {
    const inner = heavyInner();
    const plain = wrap(inner, ctx);
    const buffered = wrapBuffered(inner, ctx, 300);
    // the plain create is what overflows; every buffered step must be smaller
    const plainCreateSize = plain[0]!.data.length;
    for (const ix of buffered.ixs) {
      expect(ix.data.length).toBeLessThan(plainCreateSize);
    }
  });

  it("unwrap recovers the inner set from a BUFFERED chain too (INV-9/10)", () => {
    const inner = heavyInner();
    const c = ctx;
    const buffered = wrapBuffered(inner, c, 300);
    const recovered = unwrap(buffered.ixs, c);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.programId.equals(inner[0]!.programId)).toBe(true);
    expect(recovered[0]!.data.equals(inner[0]!.data)).toBe(true);
    expect(recovered[0]!.keys.map((k) => k.pubkey.toBase58())).toEqual(
      inner[0]!.keys.map((k) => k.pubkey.toBase58()),
    );
  });

  it("the member signs every step; the vault is never a tx-level signer", () => {
    const c = ctx;
    const { ixs } = wrapBuffered(heavyInner(), c, 300);
    const [vaultPda] = multisig.getVaultPda({
      multisigPda: c.multisigPda,
      index: c.vaultIndex,
    });
    for (const ix of ixs) {
      expect(
        ix.keys.some((k) => k.pubkey.equals(c.member) && k.isSigner),
        "member signs each step",
      ).toBe(true);
      for (const k of ix.keys) {
        if (k.pubkey.equals(vaultPda)) expect(k.isSigner).toBe(false);
      }
    }
  });
});
