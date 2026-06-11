/**
 * Spec 12.3 / Section 3 env contract: ARTIFACT_STORE=sqlite:<path>.
 * Same behavioral contract as MemoryArtifactStore, persisted.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { computeInstructionSetHash } from "../src/artifacts";
import { SqliteArtifactStore } from "../src/sqlite-store";

const a = Keypair.generate().publicKey;
const b = Keypair.generate().publicKey;
const ix = SystemProgram.transfer({ fromPubkey: a, toPubkey: b, lamports: 1 });

function dbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "artifacts-")), "artifacts.db");
}

describe("SqliteArtifactStore", () => {
  it("round-trips an artifact and persists across store instances", async () => {
    const path = dbPath();
    const proposal = Keypair.generate().publicKey;
    const hash = computeInstructionSetHash([ix]);

    const store1 = new SqliteArtifactStore(path);
    await store1.put(proposal, hash, {
      decodedSummary: "transfer 1 lamport",
      simulation: { unitsConsumed: 450 },
      redFlags: ["UNKNOWN — raw data"],
    });
    store1.close();

    const store2 = new SqliteArtifactStore(path);
    const hit = await store2.get(proposal, hash);
    expect(hit?.decodedSummary).toBe("transfer 1 lamport");
    expect(hit?.simulation).toEqual({ unitsConsumed: 450 });
    expect(hit?.redFlags).toEqual(["UNKNOWN — raw data"]);
    store2.close();
  });

  it("misses on a different hash (the INV-9 mismatch path)", async () => {
    const store = new SqliteArtifactStore(dbPath());
    const proposal = Keypair.generate().publicKey;
    await store.put(proposal, computeInstructionSetHash([ix]), {
      decodedSummary: "x",
      simulation: null,
      redFlags: [],
    });
    expect(await store.get(proposal, "deadbeef")).toBeNull();
    store.close();
  });

  it("upserts: a re-put for the same key replaces the artifact", async () => {
    const store = new SqliteArtifactStore(dbPath());
    const proposal = Keypair.generate().publicKey;
    const hash = computeInstructionSetHash([ix]);
    await store.put(proposal, hash, {
      decodedSummary: "v1",
      simulation: null,
      redFlags: [],
    });
    await store.put(proposal, hash, {
      decodedSummary: "v2",
      simulation: null,
      redFlags: [],
    });
    expect((await store.get(proposal, hash))?.decodedSummary).toBe("v2");
    store.close();
  });

  it("parses the ARTIFACT_STORE env form", () => {
    const path = dbPath();
    const store = SqliteArtifactStore.fromEnv(`sqlite:${path}`);
    expect(store).toBeInstanceOf(SqliteArtifactStore);
    store.close();
    expect(() => SqliteArtifactStore.fromEnv("postgres://nope")).toThrow(
      /sqlite:/,
    );
  });
});
