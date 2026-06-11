/**
 * Spec 12.3 — simulation/decode artifact store (written before
 * implementation). Artifacts are keyed by (proposal, instruction-set hash);
 * the UI recomputes the hash from on-chain ProposalTransactions and the
 * badge turns red on mismatch (INV-9/10). The hash must therefore be
 * deterministic, order-sensitive, and flag-sensitive.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  MemoryArtifactStore,
  computeInstructionSetHash,
} from "../src/artifacts";

const a = Keypair.generate().publicKey;
const b = Keypair.generate().publicKey;

function transfer(lamports: number) {
  return SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports });
}

describe("computeInstructionSetHash", () => {
  it("is deterministic", () => {
    const ixs = [transfer(1), transfer(2)];
    expect(computeInstructionSetHash(ixs)).toBe(computeInstructionSetHash(ixs));
  });

  it("is order-sensitive (executed order is part of what voters approved)", () => {
    const h1 = computeInstructionSetHash([transfer(1), transfer(2)]);
    const h2 = computeInstructionSetHash([transfer(2), transfer(1)]);
    expect(h1).not.toBe(h2);
  });

  it("changes when data changes by a single lamport", () => {
    expect(computeInstructionSetHash([transfer(1)])).not.toBe(
      computeInstructionSetHash([transfer(2)]),
    );
  });

  it("changes when an account flag changes (writable/signer are semantics)", () => {
    const ix1 = transfer(1);
    const ix2 = transfer(1);
    ix2.keys[1]!.isWritable = false;
    expect(computeInstructionSetHash([ix1])).not.toBe(
      computeInstructionSetHash([ix2]),
    );
  });
});

describe("MemoryArtifactStore", () => {
  it("stores and retrieves by (proposal, hash); wrong hash misses", async () => {
    const store = new MemoryArtifactStore();
    const proposal = Keypair.generate().publicKey;
    const hash = computeInstructionSetHash([transfer(1)]);
    await store.put(proposal, hash, {
      decodedSummary: "transfer 1 lamport",
      simulation: { ok: true },
      redFlags: [],
    });
    const hit = await store.get(proposal, hash);
    expect(hit?.decodedSummary).toBe("transfer 1 lamport");
    const miss = await store.get(
      proposal,
      computeInstructionSetHash([transfer(2)]),
    );
    expect(miss).toBeNull();
  });
});
