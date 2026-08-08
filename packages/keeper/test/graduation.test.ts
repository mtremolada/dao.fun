/**
 * Graduation crank — permissionless, idempotent, per-item isolated. Losing the
 * migrate race to a stranger is success, not failure.
 */
import { describe, expect, it } from "vitest";
import { Keypair, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import {
  crankMigration,
  crankMigrations,
  type GraduationDeps,
} from "../src/graduation";

const ix = () =>
  new TransactionInstruction({ programId: SystemProgram.programId, keys: [], data: Buffer.alloc(0) });

function deps(over: Partial<GraduationDeps> = {}): GraduationDeps {
  return {
    refreshCandidate: async () => ({ complete: true, migrated: false }),
    buildMigrateIx: () => ix(),
    sendAndConfirm: async () => "sig",
    ...over,
  };
}

const mint = () => Keypair.generate().publicKey;

describe("crankMigration", () => {
  it("migrates a completed, un-migrated curve", async () => {
    const r = await crankMigration({ mint: mint(), complete: true, migrated: false }, deps());
    expect(r).toEqual({ status: "migrated", signature: "sig" });
  });

  it("skips one already migrated in the cache", async () => {
    const r = await crankMigration({ mint: mint(), complete: true, migrated: true }, deps());
    expect(r.status).toBe("not-ready");
  });

  it("re-checks on chain and skips if it migrated since the cache", async () => {
    const r = await crankMigration(
      { mint: mint(), complete: true, migrated: false },
      deps({ refreshCandidate: async () => ({ complete: true, migrated: true }) }),
    );
    expect(r.status).toBe("already-migrated");
  });

  it("treats an 'already migrated' send error as success (lost the race)", async () => {
    const r = await crankMigration(
      { mint: mint(), complete: true, migrated: false },
      deps({
        sendAndConfirm: async () => {
          throw new Error("custom program error: already migrated");
        },
      }),
    );
    expect(r.status).toBe("already-migrated");
  });

  it("surfaces a genuine error without throwing", async () => {
    const r = await crankMigration(
      { mint: mint(), complete: true, migrated: false },
      deps({
        sendAndConfirm: async () => {
          throw new Error("blockhash expired");
        },
      }),
    );
    expect(r).toMatchObject({ status: "error", error: /blockhash/ });
  });
});

describe("crankMigrations", () => {
  it("isolates failures — one bad candidate does not stop the rest", async () => {
    let call = 0;
    const outcomes = await crankMigrations(
      [
        { mint: mint(), complete: true, migrated: false },
        { mint: mint(), complete: true, migrated: false },
        { mint: mint(), complete: true, migrated: false },
      ],
      deps({
        sendAndConfirm: async () => {
          call += 1;
          if (call === 2) throw new Error("rpc down");
          return "sig";
        },
      }),
    );
    expect(outcomes.map((o) => o.status)).toEqual(["migrated", "error", "migrated"]);
  });
});
