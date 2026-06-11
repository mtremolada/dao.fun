import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  airdropWithBackoff,
  initWallets,
  loadOrCreateKeypair,
} from "../scripts/init-wallets";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wallets-"));
}

describe("loadOrCreateKeypair", () => {
  it("is idempotent: second load returns the same keypair", () => {
    const dir = tempDir();
    const a = loadOrCreateKeypair(dir, "deployer");
    const b = loadOrCreateKeypair(dir, "deployer");
    expect(b.publicKey.toBase58()).toBe(a.publicKey.toBase58());
    expect(Buffer.from(b.secretKey)).toEqual(Buffer.from(a.secretKey));
  });

  it("creates distinct keypairs for distinct names", () => {
    const dir = tempDir();
    const a = loadOrCreateKeypair(dir, "deployer");
    const b = loadOrCreateKeypair(dir, "keeper");
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
  });
});

describe("initWallets (offline)", () => {
  it("writes a manifest with public keys only — no secret material", async () => {
    const dir = tempDir();
    const manifest = await initWallets({
      dir,
      names: ["deployer", "keeper", "protocol-treasury"],
      targetLamports: 0n,
    });
    expect(manifest).toHaveLength(3);

    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as Array<Record<string, string>>;
    for (const entry of parsed) {
      expect(Object.keys(entry).sort()).toEqual(["name", "publicKey"]);
      // base58 pubkey, parseable, and NOT a 64-byte secret
      expect(() => new PublicKey(entry.publicKey!)).not.toThrow();
    }
    // No secret key bytes anywhere in the manifest file
    for (const name of ["deployer", "keeper", "protocol-treasury"]) {
      const kp = loadOrCreateKeypair(dir, name);
      expect(raw).not.toContain(JSON.stringify(Array.from(kp.secretKey)).slice(1, 40));
    }
  });

  it("is idempotent across runs", async () => {
    const dir = tempDir();
    const first = await initWallets({ dir, names: ["deployer"], targetLamports: 0n });
    const second = await initWallets({ dir, names: ["deployer"], targetLamports: 0n });
    expect(second).toEqual(first);
    // exactly one keypair file + manifest
    expect(readdirSync(dir).sort()).toEqual(["deployer.keypair.json", "manifest.json"]);
  });
});

describe("airdropWithBackoff", () => {
  it("retries with exponential backoff and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    const conn = {
      requestAirdrop: vi
        .fn()
        .mockRejectedValueOnce(new Error("429"))
        .mockRejectedValueOnce(new Error("429"))
        .mockResolvedValue("sig"),
      getLatestBlockhash: vi
        .fn()
        .mockResolvedValue({ blockhash: "x", lastValidBlockHeight: 1 }),
      confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
    } as unknown as Connection;

    const promise = airdropWithBackoff(conn, Keypair.generate().publicKey, 1n, 5, 100);
    await vi.advanceTimersByTimeAsync(100 + 200); // backoff doubles: 100ms, 200ms
    const ok = await promise;
    expect(ok).toBe(true);
    expect((conn.requestAirdrop as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    vi.useRealTimers();
  });

  it("returns false after exhausting attempts (never throws)", async () => {
    const conn = {
      requestAirdrop: vi.fn().mockRejectedValue(new Error("faucet dry")),
      getLatestBlockhash: vi.fn(),
      confirmTransaction: vi.fn(),
    } as unknown as Connection;
    const ok = await airdropWithBackoff(conn, Keypair.generate().publicKey, 1n, 2, 1);
    expect(ok).toBe(false);
  });

  it("skips airdrop when balance already meets target", async () => {
    const dir = tempDir();
    const conn = {
      getBalance: vi.fn().mockResolvedValue(5_000_000_000),
      requestAirdrop: vi.fn(),
    } as unknown as Connection;
    await initWallets({
      dir,
      names: ["deployer"],
      targetLamports: 2_000_000_000n,
      connection: conn,
      log: () => {},
    });
    expect((conn.requestAirdrop as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });
});
