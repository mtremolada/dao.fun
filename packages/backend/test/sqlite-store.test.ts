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
import { SqliteArtifactStore, SqliteLaunchStore } from "../src/sqlite-store";
import { runLaunch, type LaunchStep } from "../src/launch-machine";

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

describe("SqliteLaunchStore", () => {
  function launchDbPath(): string {
    return join(mkdtempSync(join(tmpdir(), "launches-")), "launches.db");
  }

  it("persists launch state across instances; a crashed run resumes only the missing steps", async () => {
    const path = launchDbPath();
    const ran: string[] = [];
    const stepA: LaunchStep = {
      name: "a",
      run: async () => {
        ran.push("a");
        return ["sig-a"];
      },
    };
    const failingB: LaunchStep = {
      name: "b",
      run: async () => {
        ran.push("b-fail");
        throw new Error("boom");
      },
    };

    const store1 = new SqliteLaunchStore(path);
    const failed = await runLaunch("L1", [stepA, failingB], store1);
    expect(failed.status).toBe("failed");
    expect(failed.failedStep).toBe("b");
    expect(failed.completedSteps["a"]).toEqual(["sig-a"]);
    store1.close();

    // A fresh process/store loads the persisted state and re-runs ONLY b.
    const store2 = new SqliteLaunchStore(path);
    const okB: LaunchStep = {
      name: "b",
      run: async () => {
        ran.push("b-ok");
        return ["sig-b"];
      },
    };
    const done = await runLaunch("L1", [stepA, okB], store2);
    expect(done.status).toBe("complete");
    expect(done.completedSteps).toEqual({ a: ["sig-a"], b: ["sig-b"] });
    store2.close();

    // a ran once, b failed once then succeeded — a was NOT re-run on resume.
    expect(ran).toEqual(["a", "b-fail", "b-ok"]);
  });

  it("parses the LAUNCH_STORE env form and rejects other schemes", () => {
    const store = SqliteLaunchStore.fromEnv(`sqlite:${launchDbPath()}`);
    expect(store).toBeInstanceOf(SqliteLaunchStore);
    store.close();
    expect(() => SqliteLaunchStore.fromEnv("redis://nope")).toThrow(/sqlite:/);
  });
});
