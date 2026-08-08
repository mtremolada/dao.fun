/**
 * Unit coverage for the launchpad SDK surface that the bankrun integration
 * suites do NOT exercise: the event codec the indexer depends on, the error
 * map, the account decoders, and cluster-aware Raydium selection.
 *
 * (Instruction building, PDAs, and the discriminators are proven against the
 * real deployed binaries by tests/launchpad-*.integration.test.ts, which
 * drive the very same SDK builders through the bankrun harness.)
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { RAYDIUM_CPMM_PROGRAM_ID_DEVNET } from "../src/constants";
import {
  EVENT_IX_TAG,
  eventDiscriminator,
  ixDiscriminator,
  raydiumCpmmAddresses,
  solVaultPda,
  decodeCurve,
  decodeConfig,
  decodeLaunchpadEvent,
  explainLaunchpadError,
} from "../src/launchpad";

// ---- byte builders that mirror the on-chain borsh layout exactly ----
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const str = (s: string) => {
  const body = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
};
const KEY_A = new PublicKey("11111111111111111111111111111112");
const KEY_B = new PublicKey("So11111111111111111111111111111111111111112");

function eventBytes(name: string, body: Buffer): Buffer {
  return Buffer.concat([EVENT_IX_TAG, eventDiscriminator(name), body]);
}

describe("launchpad discriminators", () => {
  it("are 8 bytes and stable", () => {
    for (const n of ["buy", "sell", "migrate", "create_coin", "collect_creator_fee"]) {
      expect(ixDiscriminator(n)).toHaveLength(8);
    }
    // Deterministic sha256 prefix — a change here is a wire-breaking change.
    expect(ixDiscriminator("buy").equals(ixDiscriminator("buy"))).toBe(true);
    expect(ixDiscriminator("buy").equals(ixDiscriminator("sell"))).toBe(false);
  });
});

describe("event codec", () => {
  it("decodes a TradeEvent from emit_cpi inner-instruction bytes", () => {
    const body = Buffer.concat([
      KEY_A.toBuffer(), // mint
      KEY_B.toBuffer(), // user
      Buffer.from([1]), // is_buy
      u64(1000n), // token_amount
      u64(2000n), // sol_amount
      u64(14n), // protocol_fee
      u64(6n), // creator_fee
      u64(30_000_000_002_000n), // virtual_sol
      u64(1_072_999_999_999_000n), // virtual_token
      u64(2000n), // real_sol
      u64(793_099_999_999_000n), // real_token
    ]);
    const ev = decodeLaunchpadEvent(eventBytes("TradeEvent", body));
    expect(ev?.kind).toBe("trade");
    if (ev?.kind !== "trade") throw new Error("wrong kind");
    expect(ev.mint.equals(KEY_A)).toBe(true);
    expect(ev.user.equals(KEY_B)).toBe(true);
    expect(ev.isBuy).toBe(true);
    expect(ev.tokenAmount).toBe(1000n);
    expect(ev.solAmount).toBe(2000n);
    expect(ev.protocolFee).toBe(14n);
    expect(ev.creatorFee).toBe(6n);
    expect(ev.realSol).toBe(2000n);
    expect(ev.realToken).toBe(793_099_999_999_000n);
  });

  it("decodes a CreateEvent with string fields", () => {
    const body = Buffer.concat([
      KEY_A.toBuffer(),
      KEY_B.toBuffer(),
      str("My Coin"),
      str("MYC"),
      str("https://arweave.net/abc"),
      u64(30_000_000_000n),
      u64(1_073_000_000_000_000n),
      u64(793_100_000_000_000n),
      u64(1_000_000_000_000_000n),
    ]);
    const ev = decodeLaunchpadEvent(eventBytes("CreateEvent", body));
    expect(ev?.kind).toBe("create");
    if (ev?.kind !== "create") throw new Error("wrong kind");
    expect(ev.name).toBe("My Coin");
    expect(ev.symbol).toBe("MYC");
    expect(ev.uri).toBe("https://arweave.net/abc");
    expect(ev.tokenTotalSupply).toBe(1_000_000_000_000_000n);
  });

  it("decodes CompleteEvent and MigrateEvent", () => {
    const complete = decodeLaunchpadEvent(
      eventBytes(
        "CompleteEvent",
        Buffer.concat([KEY_A.toBuffer(), u64(85_005_359_057n), u64(206_900_000_000_000n)]),
      ),
    );
    expect(complete?.kind).toBe("complete");
    if (complete?.kind === "complete") {
      expect(complete.raisedLamports).toBe(85_005_359_057n);
      expect(complete.reservedTokens).toBe(206_900_000_000_000n);
    }

    const migrate = decodeLaunchpadEvent(
      eventBytes(
        "MigrateEvent",
        Buffer.concat([
          KEY_A.toBuffer(),
          KEY_B.toBuffer(),
          u64(84_813_202_337n),
          u64(206_900_000_000_000n),
          u64(11_935n),
          u64(150_000_000n),
          u64(0n),
        ]),
      ),
    );
    expect(migrate?.kind).toBe("migrate");
    if (migrate?.kind === "migrate") {
      expect(migrate.poolState.equals(KEY_B)).toBe(true);
      expect(migrate.createPoolFee).toBe(150_000_000n);
      expect(migrate.graduationFee).toBe(0n);
    }
  });

  it("returns null for non-events and unknown discriminators (upgrade tolerance)", () => {
    expect(decodeLaunchpadEvent(Buffer.from("not an event"))).toBeNull();
    // Right tag, unknown discriminator: a future event a stale indexer ignores.
    const unknown = Buffer.concat([
      EVENT_IX_TAG,
      eventDiscriminator("SomeFutureEvent"),
      KEY_A.toBuffer(),
    ]);
    expect(decodeLaunchpadEvent(unknown)).toBeNull();
  });
});

describe("account decoders", () => {
  it("round-trips a BondingCurve at the pinned offsets", () => {
    const d = Buffer.alloc(8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1);
    KEY_A.toBuffer().copy(d, 8);
    KEY_B.toBuffer().copy(d, 40);
    u64(30_000_000_000n).copy(d, 72);
    u64(1_073_000_000_000_000n).copy(d, 80);
    u64(1234n).copy(d, 88);
    u64(793_000_000_000_000n).copy(d, 96);
    u16(70).copy(d, 104);
    u16(30).copy(d, 106);
    d[108] = 1; // complete
    d[109] = 0; // migrated
    KEY_A.toBuffer().copy(d, 110);
    const c = decodeCurve(d);
    expect(c.mint.equals(KEY_A)).toBe(true);
    expect(c.realSol).toBe(1234n);
    expect(c.protocolFeeBps).toBe(70);
    expect(c.creatorFeeBps).toBe(30);
    expect(c.complete).toBe(true);
    expect(c.migrated).toBe(false);
  });

  it("decodes a Config's immutable Raydium addresses", () => {
    const d = Buffer.alloc(8 + 32 * 2 + 2 + 2 + 8 * 5 + 32 * 3 + 1 + 64);
    KEY_A.toBuffer().copy(d, 8); // authority
    KEY_B.toBuffer().copy(d, 40); // fee_recipient
    u16(70).copy(d, 72);
    u16(30).copy(d, 74);
    KEY_A.toBuffer().copy(d, 116); // cpmm_program
    const cfg = decodeConfig(d);
    expect(cfg.authority.equals(KEY_A)).toBe(true);
    expect(cfg.feeRecipient.equals(KEY_B)).toBe(true);
    expect(cfg.protocolFeeBps).toBe(70);
    expect(cfg.cpmmProgram.equals(KEY_A)).toBe(true);
  });
});

describe("cluster-aware Raydium addresses", () => {
  it("selects the devnet program and derives its authority (not the mainnet one)", () => {
    const dev = raydiumCpmmAddresses("devnet");
    const main = raydiumCpmmAddresses("mainnet");
    expect(dev.program.equals(RAYDIUM_CPMM_PROGRAM_ID_DEVNET)).toBe(true);
    // The authority is a PDA of the cluster's own program, so they differ —
    // the devnet trap is passing mainnet's authority to a devnet migrate.
    expect(dev.authority.equals(main.authority)).toBe(false);
  });

  it("derives the known mainnet CPMM authority (proves the seed)", () => {
    // GpMZbSM2… is Raydium's published mainnet vault/LP-mint authority; the
    // migrate integration test also relies on this derivation being right.
    expect(raydiumCpmmAddresses("mainnet").authority.toBase58()).toBe(
      "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
    );
  });
});

describe("error map", () => {
  it("explains a raw code and parses hex/decimal from logs", () => {
    expect(explainLaunchpadError(6003)).toMatch(/trading is closed/i);
    expect(explainLaunchpadError("custom program error: 0x1773")).toMatch(
      /trading is closed/i,
    );
    expect(explainLaunchpadError("Error Number: 6007")).toMatch(/slippage/i);
    expect(explainLaunchpadError(2012)).toMatch(/address constraint/i);
    expect(explainLaunchpadError("nothing here")).toBeUndefined();
  });
});

describe("pdas", () => {
  it("derives a deterministic sol vault", () => {
    expect(solVaultPda(KEY_B).equals(solVaultPda(KEY_B))).toBe(true);
  });
});
