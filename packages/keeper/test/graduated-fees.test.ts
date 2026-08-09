/**
 * The post-graduation crank's decision logic, offline.
 *
 * What matters here is that the keeper is not special: every outcome a
 * stranger could cause by winning the race must read as SUCCESS, and every
 * settled state (devnet's burn branch, nothing accrued yet) must read as
 * "done for now" rather than an error someone has to page about.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  crankGraduatedFees,
  crankGraduatedFeesBatch,
  type GraduatedFeeDeps,
} from "../src/graduated-fees";

const mint = () => Keypair.generate().publicKey;
const ix = () =>
  new TransactionInstruction({
    programId: PublicKey.default,
    keys: [],
    data: Buffer.alloc(0),
  });

function deps(over: Partial<GraduatedFeeDeps> = {}): GraduatedFeeDeps {
  return {
    refresh: async () => ({ migrated: true, locked: false }),
    buildLockIxs: () => [ix()],
    buildCollectIxs: () => [ix()],
    sendAndConfirm: async () => "sig",
    ...over,
  };
}

describe("post-graduation crank", () => {
  it("locks a migrated coin that has not been locked yet", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: false },
      deps(),
    );
    expect(out).toEqual({ status: "locked", signature: "sig" });
  });

  it("collects once the coin is locked", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: true },
      deps({ refresh: async () => ({ migrated: true, locked: true }) }),
    );
    expect(out).toEqual({ status: "collected", signature: "sig" });
  });

  it("does exactly one step per tick — a fresh lock does not also collect", async () => {
    const send = vi.fn(async () => "sig");
    await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: false },
      deps({ sendAndConfirm: send }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatch(/^lock /);
  });

  it("re-reads state before sending, so a stale cache cannot double-lock", async () => {
    // Cache says unlocked; chain says locked. The chain wins.
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: false },
      deps({ refresh: async () => ({ migrated: true, locked: true }) }),
    );
    expect(out.status).toBe("collected");
  });

  it("treats losing the lock race to a stranger as success", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: false },
      deps({
        sendAndConfirm: async () => {
          throw new Error("Allocate: account Address { .. } already in use");
        },
      }),
    );
    expect(out).toEqual({ status: "already-locked" });
  });

  it("treats an empty collect as done, not as an error to page about", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: true },
      deps({
        refresh: async () => ({ migrated: true, locked: true }),
        sendAndConfirm: async () => {
          throw new Error("Error Code: NothingToCollect");
        },
      }),
    );
    expect(out).toEqual({ status: "nothing-to-collect" });
  });

  it("treats a cluster without a locker as settled — devnet burns", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: false },
      deps({
        sendAndConfirm: async () => {
          throw new Error(
            "Error Code: LockingDisabled. liquidity locking is not configured on this cluster",
          );
        },
      }),
    );
    expect(out).toEqual({ status: "not-ready" });
  });

  it("skips a coin that has not migrated", async () => {
    const send = vi.fn(async () => "sig");
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: false, locked: false },
      deps({ sendAndConfirm: send }),
    );
    expect(out).toEqual({ status: "not-ready" });
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces a real failure as an error", async () => {
    const out = await crankGraduatedFees(
      { mint: mint(), migrated: true, locked: true },
      deps({
        refresh: async () => ({ migrated: true, locked: true }),
        sendAndConfirm: async () => {
          throw new Error("blockhash not found");
        },
      }),
    );
    expect(out).toEqual({ status: "error", error: "blockhash not found" });
  });

  it("isolates failures — one bad coin never stops the batch", async () => {
    const bad = mint();
    const coins = [
      { mint: bad, migrated: true, locked: true },
      { mint: mint(), migrated: true, locked: true },
    ];
    const out = await crankGraduatedFeesBatch(
      coins,
      deps({
        refresh: async () => ({ migrated: true, locked: true }),
        sendAndConfirm: async (_ixs, label) => {
          if (label.includes(bad.toBase58())) throw new Error("boom");
          return "sig";
        },
      }),
    );
    expect(out[0]!.status).toBe("error");
    expect(out[1]).toEqual({ status: "collected", signature: "sig" });
  });
});
