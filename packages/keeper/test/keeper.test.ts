/**
 * Spec 6.5 — keeper tests (written before implementation).
 *
 * The keeper has no authority: it pays tx fees and triggers permissionless
 * collects. Gross accounting (INV-8), idempotency, INV-2 signer refusal,
 * retry/backoff, and checked math at u64 bounds (INV-6) are covered here
 * with injected deps; live venue behavior is the Stage 1 integration suite.
 */
import { describe, expect, it, vi } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { sweepVault, runTick, type KeeperDeps } from "../src/keeper";

const keeperKey = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;

function collectIx(signer?: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: Keypair.generate().publicKey,
    keys: signer
      ? [{ pubkey: signer, isSigner: true, isWritable: true }]
      : [{ pubkey: vault, isSigner: false, isWritable: true }],
    data: Buffer.alloc(8),
  });
}

function makeDeps(overrides: Partial<KeeperDeps> = {}): KeeperDeps {
  // Default scenario: 5000 lamports accrued; vault balance grows by exactly
  // that amount when the collect lands.
  let collected = false;
  return {
    keeper: keeperKey,
    getAccruedFees: vi.fn(async () => (collected ? 0n : 5000n)),
    getVaultBalance: vi.fn(async () => (collected ? 15_000n : 10_000n)),
    buildCollectIxs: vi.fn(async () => [collectIx()]),
    sendAndConfirm: vi.fn(async () => {
      collected = true;
      return "sig-test";
    }),
    maxAttempts: 3,
    backoffMs: 1,
    ...overrides,
  };
}

describe("sweepVault", () => {
  it("idempotent on zero accrued: no tx sent, returns null", async () => {
    const deps = makeDeps({ getAccruedFees: vi.fn(async () => 0n) });
    expect(await sweepVault(vault, deps)).toBeNull();
    expect(deps.sendAndConfirm).not.toHaveBeenCalled();
  });

  it("records the GROSS vault delta (INV-8) and the signature", async () => {
    const deps = makeDeps();
    const result = await sweepVault(vault, deps);
    expect(result).not.toBeNull();
    expect(result!.grossLamports).toBe(5000n);
    expect(result!.signature).toBe("sig-test");
    expect(result!.vault.equals(vault)).toBe(true);
  });

  it("second run after a sweep is a no-op (idempotency end-to-end)", async () => {
    const deps = makeDeps();
    await sweepVault(vault, deps);
    expect(await sweepVault(vault, deps)).toBeNull();
    expect(deps.sendAndConfirm).toHaveBeenCalledTimes(1);
  });

  it("INV-2: refuses any collect ix that requires a non-keeper signer", async () => {
    const stranger = Keypair.generate().publicKey;
    const deps = makeDeps({
      buildCollectIxs: vi.fn(async () => [collectIx(stranger)]),
    });
    await expect(sweepVault(vault, deps)).rejects.toThrow(/INV-2/);
    expect(deps.sendAndConfirm).not.toHaveBeenCalled();
  });

  it("keeper as fee-payer signer is acceptable", async () => {
    const deps = makeDeps({
      buildCollectIxs: vi.fn(async () => [collectIx(keeperKey)]),
    });
    expect(await sweepVault(vault, deps)).not.toBeNull();
  });

  it("retries with backoff and succeeds on a later attempt", async () => {
    let collected = false;
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("blockhash expired"))
      .mockRejectedValueOnce(new Error("node behind"))
      .mockImplementation(async () => {
        collected = true;
        return "sig-retry";
      });
    const deps = makeDeps({
      sendAndConfirm: send,
      getVaultBalance: vi.fn(async () => (collected ? 15_000n : 10_000n)),
    });
    const result = await sweepVault(vault, deps);
    expect(result!.signature).toBe("sig-retry");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting attempts (caller alerts; INV does not improvise)", async () => {
    const deps = makeDeps({
      sendAndConfirm: vi.fn().mockRejectedValue(new Error("down")),
    });
    await expect(sweepVault(vault, deps)).rejects.toThrow(/3 attempts/);
  });

  it("INV-6: a negative vault delta is a hard error, not a silent wrap", async () => {
    const deps = makeDeps({
      getVaultBalance: vi
        .fn()
        .mockResolvedValueOnce(10_000n) // before
        .mockResolvedValueOnce(9_000n), // after: impossible, must throw
    });
    await expect(sweepVault(vault, deps)).rejects.toThrow(/INV-6|decreased/);
  });

  it("INV-6: handles balances near u64 max without precision loss", async () => {
    const U64MAX = 2n ** 64n - 1n;
    let collected = false;
    const deps = makeDeps({
      getAccruedFees: vi.fn(async () => (collected ? 0n : 7n)),
      getVaultBalance: vi.fn(async () => (collected ? U64MAX : U64MAX - 7n)),
      sendAndConfirm: vi.fn(async () => {
        collected = true;
        return "sig-u64";
      }),
    });
    const result = await sweepVault(vault, deps);
    expect(result!.grossLamports).toBe(7n);
  });
});

describe("runTick", () => {
  it("sweeps every managed vault and isolates per-vault failures", async () => {
    const good = Keypair.generate().publicKey;
    const bad = Keypair.generate().publicKey;
    let collected = false;
    const deps = makeDeps({
      getAccruedFees: vi.fn(async () => (collected ? 0n : 5000n)),
      buildCollectIxs: vi.fn(async (v: PublicKey) => {
        if (v.equals(bad)) throw new Error("venue exploded");
        return [collectIx()];
      }),
      sendAndConfirm: vi.fn(async () => {
        collected = true;
        return "sig-tick";
      }),
    });
    const onError = vi.fn();
    const results = await runTick([bad, good], deps, onError);
    expect(results).toHaveLength(1);
    expect(results[0]!.vault.equals(good)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].equals(bad)).toBe(true);
  });
});
