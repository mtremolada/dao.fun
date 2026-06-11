/**
 * Spec 6.4 — ExecutionAdapter unit tests (written before implementation).
 *
 * The full path (insert into a proposal -> vote -> warp past hold-up ->
 * execute -> vault delta) is the Stage 1 integration suite on a validator
 * with cloned programs; CU measurement and oversized-set splitting live
 * there too. Here: structure, member plumbing, and the wrap/unwrap
 * round-trip the decoder depends on (INV-9/10 support).
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { SQUADS_V4_PROGRAM_ID } from "../src/constants";
import { unwrap, wrap, type WrapContext } from "../src/execution-adapter";
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
