/**
 * Chain reader (spec 6.7 server side) — written before implementation.
 *
 * The reader recomputes the instruction-set hash from what is ON CHAIN
 * (INV-9: hash what actually executes, i.e. the unwrapped inner ixs of a
 * Squads-wrapped proposal) and classifies vault balance deltas for the
 * dashboard's sweep history. These are the pure seams; RPC plumbing is
 * exercised by the live read against the GATE 1 mainnet DAO.
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { unwrap, wrap, type WrapContext } from "@daofun/sdk";
import { computeInstructionSetHash } from "../src/artifacts";
import { hashWrappedInstructionSet, vaultDelta } from "../src/chain-reader";

function ctx(): WrapContext {
  return {
    multisigPda: Keypair.generate().publicKey,
    vaultIndex: 0,
    transactionIndex: 1n,
    member: Keypair.generate().publicKey,
  };
}

function innerIxs(): TransactionInstruction[] {
  return [
    SystemProgram.transfer({
      fromPubkey: Keypair.generate().publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 890_880,
    }),
  ];
}

describe("hashWrappedInstructionSet (INV-9 chain side)", () => {
  it("hashes the UNWRAPPED inner set of a Squads-wrapped proposal", () => {
    const inner = innerIxs();
    const wrapped = wrap(inner, ctx());
    // The badge must compare against the same hash the artifact was
    // published under: the inner instructions, not the Squads plumbing.
    expect(hashWrappedInstructionSet(wrapped)).toBe(
      computeInstructionSetHash(unwrap(wrapped, ctx())),
    );
    expect(hashWrappedInstructionSet(wrapped)).toBe(
      computeInstructionSetHash(inner),
    );
  });

  it("falls back to hashing the raw set when no vaultTransactionCreate is present", () => {
    const raw = innerIxs();
    expect(hashWrappedInstructionSet(raw)).toBe(
      computeInstructionSetHash(raw),
    );
  });

  it("returns null for an empty instruction set", () => {
    expect(hashWrappedInstructionSet([])).toBeNull();
  });

  it("any tamper with the inner data changes the hash", () => {
    const inner = innerIxs();
    const wrapped = wrap(inner, ctx());
    const tampered = wrap(
      [
        new TransactionInstruction({
          programId: inner[0]!.programId,
          keys: inner[0]!.keys,
          data: Buffer.concat([inner[0]!.data.subarray(0, -1), Buffer.from([0xff])]),
        }),
      ],
      ctx(),
    );
    expect(hashWrappedInstructionSet(tampered)).not.toBe(
      hashWrappedInstructionSet(wrapped),
    );
  });
});

describe("vaultDelta (sweep history)", () => {
  const vault = Keypair.generate().publicKey;
  const other = Keypair.generate().publicKey;

  it("returns post - pre for the vault's account index", () => {
    expect(
      vaultDelta(vault, [other, vault], [5_000, 1_000_000], [4_000, 1_250_000]),
    ).toBe(250_000);
    expect(
      vaultDelta(vault, [vault, other], [890_880, 0], [0, 885_880]),
    ).toBe(-890_880);
  });

  it("returns 0 when the vault is not in the transaction", () => {
    expect(vaultDelta(vault, [other], [1], [2])).toBe(0);
  });
});
