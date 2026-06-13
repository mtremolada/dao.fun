/**
 * Production config loader — the boot-time contract that decides whether
 * the server starts at all (spec 11 halt-until-funded) and whether the
 * unaudited guarded program is exposed (D-034 GATE 3 override).
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { GATE3_ACK_STRING, loadProdConfig, type Env } from "../src/config";

const TREASURY = Keypair.generate().publicKey.toBase58();

function base(over: Env = {}): Env {
  return {
    SOLANA_RPC_URL: "https://rpc.example",
    SOLANA_CLUSTER: "mainnet-beta",
    ARTIFACT_STORE: "sqlite:./data/a.db",
    LAUNCH_STORE: "sqlite:./data/l.db",
    PROTOCOL_TREASURY: TREASURY,
    LAUNCH_FEE_LAMPORTS: "1000000",
    ...over,
  };
}

describe("loadProdConfig", () => {
  it("parses a complete mainnet config with guarded locked by default", () => {
    const cfg = loadProdConfig(base());
    expect(cfg.cluster).toBe("mainnet-beta");
    expect(cfg.launchFeeLamports).toBe(1_000_000n);
    expect(cfg.protocolTreasury.toBase58()).toBe(TREASURY);
    expect(cfg.guardedEnabled).toBe(false);
    expect(cfg.apiPort).toBe(4404);
  });

  it("halts on any missing required env", () => {
    for (const key of [
      "SOLANA_RPC_URL",
      "SOLANA_CLUSTER",
      "ARTIFACT_STORE",
      "LAUNCH_STORE",
      "PROTOCOL_TREASURY",
      "LAUNCH_FEE_LAMPORTS",
    ]) {
      const env = base();
      delete env[key];
      expect(() => loadProdConfig(env), key).toThrow(
        new RegExp(`${key}|valid base58|non-negative`),
      );
    }
  });

  it("rejects malformed values", () => {
    expect(() => loadProdConfig(base({ SOLANA_CLUSTER: "testnet" }))).toThrow(
      /mainnet-beta.*devnet/,
    );
    expect(() => loadProdConfig(base({ ARTIFACT_STORE: "redis:x" }))).toThrow(
      /ARTIFACT_STORE/,
    );
    expect(() => loadProdConfig(base({ LAUNCH_STORE: "/tmp/x" }))).toThrow(
      /LAUNCH_STORE/,
    );
    expect(() => loadProdConfig(base({ PROTOCOL_TREASURY: "not-a-key" }))).toThrow(
      /base58/,
    );
    expect(() => loadProdConfig(base({ LAUNCH_FEE_LAMPORTS: "-5" }))).toThrow(
      /non-negative/,
    );
    expect(() => loadProdConfig(base({ LAUNCH_FEE_LAMPORTS: "1.5" }))).toThrow(
      /non-negative/,
    );
  });

  describe("guarded enablement (GATE 3 override)", () => {
    it("devnet enables guarded freely with GUARDED_ENABLED=true", () => {
      const cfg = loadProdConfig(
        base({ SOLANA_CLUSTER: "devnet", GUARDED_ENABLED: "true" }),
      );
      expect(cfg.guardedEnabled).toBe(true);
    });

    it("mainnet REFUSES guarded without the explicit ack", () => {
      expect(() =>
        loadProdConfig(base({ GUARDED_ENABLED: "true" })),
      ).toThrow(/GATE3_OVERRIDE_ACK/);
    });

    it("mainnet enables guarded only with the exact ack string", () => {
      const cfg = loadProdConfig(
        base({
          GUARDED_ENABLED: "true",
          GATE3_OVERRIDE_ACK: GATE3_ACK_STRING,
        }),
      );
      expect(cfg.guardedEnabled).toBe(true);
    });

    it("a wrong ack string does not enable guarded", () => {
      expect(() =>
        loadProdConfig(
          base({ GUARDED_ENABLED: "true", GATE3_OVERRIDE_ACK: "yolo" }),
        ),
      ).toThrow(/GATE3_OVERRIDE_ACK/);
    });
  });
});
