/**
 * Gate SDK unit tests (Option A, D-033): the guarded veto arithmetic and
 * the InstructionData wire format the on-chain validation engine parses.
 * The binary-facing behavior is pinned by
 * tests/stage3-guarded.integration.test.ts; these tests cover the pure
 * math and serialization without a network.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  buildGateProposeIxs,
  deriveGate,
  gateSeatCouncilTokens,
  guardedVetoPercent,
  serializeInstructionSet,
} from "../src/gate";

describe("guardedVetoPercent", () => {
  it("pins the binary-verified example: 2 humans, unanimous nominal -> 30%", () => {
    // The spike + integration suite proved on the deployed binary that
    // with council supply 5 (H=2 + gate seat 3), threshold 30%: one human
    // veto (20%) does not tip, two (40%) do.
    expect(guardedVetoPercent(2, 100)).toBe(30);
  });

  it("the chosen percent is STRICTLY between k*-1 and k* human votes for all H and nominals", () => {
    for (let h = 1; h <= 20; h++) {
      const supply = 2 * h + 1;
      for (let nominal = 1; nominal <= 100; nominal++) {
        const p = guardedVetoPercent(h, nominal);
        const k = Math.max(1, Math.ceil((h * nominal) / 100));
        // strict on both sides: correct under >= and > program semantics
        expect((k - 1) * 100).toBeLessThan(p * supply);
        expect(k * 100).toBeGreaterThan(p * supply);
        // and a sane percent
        expect(p).toBeGreaterThanOrEqual(1);
        expect(p).toBeLessThanOrEqual(100);
      }
    }
  });

  it("rejects invalid inputs", () => {
    expect(() => guardedVetoPercent(0, 50)).toThrow(/humanCount/);
    expect(() => guardedVetoPercent(50, 50)).toThrow(/humanCount/);
    expect(() => guardedVetoPercent(2, 0)).toThrow(/nominalPercent/);
    expect(() => guardedVetoPercent(2, 101)).toThrow(/nominalPercent/);
    expect(() => guardedVetoPercent(2.5, 50)).toThrow(/humanCount/);
  });

  it("gate seat is always H+1 (exclusivity arithmetic)", () => {
    expect(gateSeatCouncilTokens(1)).toBe(2);
    expect(gateSeatCouncilTokens(5)).toBe(6);
  });
});

describe("serializeInstructionSet", () => {
  it("round-trips through the exact layout the on-chain reader parses", () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const ixs = [
      new TransactionInstruction({
        programId: a,
        keys: [
          { pubkey: b, isSigner: true, isWritable: false },
          { pubkey: a, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([1, 2, 3]),
      }),
      new TransactionInstruction({
        programId: b,
        keys: [],
        data: Buffer.alloc(0),
      }),
    ];
    const bytes = serializeInstructionSet(ixs);

    // hand-parse with the same rules as the program's Reader
    let pos = 0;
    const u32 = () => {
      const v = bytes.readUInt32LE(pos);
      pos += 4;
      return v;
    };
    expect(u32()).toBe(2);
    // ix 0
    expect(bytes.subarray(pos, pos + 32).equals(a.toBuffer())).toBe(true);
    pos += 32;
    expect(u32()).toBe(2); // metas
    expect(bytes.subarray(pos, pos + 32).equals(b.toBuffer())).toBe(true);
    pos += 32;
    expect([bytes[pos], bytes[pos + 1]]).toEqual([1, 0]); // signer, !writable
    pos += 2;
    pos += 34; // second meta
    expect(u32()).toBe(3); // data len
    expect([...bytes.subarray(pos, pos + 3)]).toEqual([1, 2, 3]);
    pos += 3;
    // ix 1
    expect(bytes.subarray(pos, pos + 32).equals(b.toBuffer())).toBe(true);
    pos += 32;
    expect(u32()).toBe(0);
    expect(u32()).toBe(0);
    expect(pos).toBe(bytes.length); // exhausted — the program requires it
  });
});

describe("buildGateProposeIxs", () => {
  const refs = {
    realm: Keypair.generate().publicKey,
    governance: Keypair.generate().publicKey,
    communityMint: Keypair.generate().publicKey,
    councilMint: Keypair.generate().publicKey,
  };
  const wrapCtx = {
    multisigPda: Keypair.generate().publicKey,
    vaultIndex: 0,
    transactionIndex: 1n,
    member: Keypair.generate().publicKey,
  };

  it("refuses an empty instruction set", async () => {
    await expect(
      buildGateProposeIxs({
        refs,
        requester: Keypair.generate().publicKey,
        name: "x",
        innerIxs: [],
        wrapCtx,
        holdUpSeconds: 0,
      }),
    ).rejects.toThrow(/empty/);
  });

  it("refuses inner sets that would need the buffered Squads chain", async () => {
    // ~40 transfers blow the plain vaultTransactionCreate budget
    const inner = Array.from({ length: 40 }, () =>
      SystemProgram.transfer({
        fromPubkey: Keypair.generate().publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    );
    await expect(
      buildGateProposeIxs({
        refs,
        requester: Keypair.generate().publicKey,
        name: "x",
        innerIxs: inner,
        wrapCtx,
        holdUpSeconds: 0,
      }),
    ).rejects.toThrow(/plain wrap/);
  });

  it("derives one PT address per wrapped leg and a deterministic gate PDA", async () => {
    const made = await buildGateProposeIxs({
      refs,
      requester: Keypair.generate().publicKey,
      name: "x",
      innerIxs: [
        SystemProgram.transfer({
          fromPubkey: wrapCtx.member,
          toPubkey: wrapCtx.member,
          lamports: 1,
        }),
      ],
      directIxs: [
        SystemProgram.transfer({
          fromPubkey: wrapCtx.member,
          toPubkey: wrapCtx.member,
          lamports: 2,
        }),
      ],
      wrapCtx,
      holdUpSeconds: 60,
    });
    expect(made.ptAddrs).toHaveLength(made.wrapped.length);
    expect(made.groups.inserts).toHaveLength(made.wrapped.length);
    expect(made.groups.create).toHaveLength(1);
    expect(made.groups.signOff).toHaveLength(1);
    expect(deriveGate(refs.realm).equals(deriveGate(refs.realm))).toBe(true);
  });
});
