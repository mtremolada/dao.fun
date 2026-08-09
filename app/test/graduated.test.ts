/**
 * The one thing this decoder must never do is render a BURNED coin as a
 * zeroed fee stream — devnet burns every coin, so "no record" is the common
 * case, not an error. The rest is making sure the recovery number, which is
 * the only figure a creator will read as a promise, cannot lie.
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { decodeGraduatedFees, fetchGraduatedFeesMap } from "../lib/graduated";

function record(cost: bigint, recovered: bigint): Buffer {
  const d = Buffer.alloc(89);
  new PublicKey("11111111111111111111111111111112").toBuffer().copy(d, 8);
  new PublicKey("So11111111111111111111111111111111111111112").toBuffer().copy(d, 40);
  d.writeBigUInt64LE(cost, 72);
  d.writeBigUInt64LE(recovered, 80);
  return d;
}

describe("graduated fee record", () => {
  it("reports what is still owed while the graduation is being repaid", () => {
    const g = decodeGraduatedFees(record(24_838_720n, 10_000_000n));
    expect(g.outstanding).toBe(14_838_720n);
    expect(g.recoveredRatio).toBeCloseTo(0.4026, 3);
    expect(g.feeNftMint.toBase58()).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });

  it("clamps once repaid — recovery never reads as over 100%", () => {
    const g = decodeGraduatedFees(record(24_838_720n, 24_838_720n));
    expect(g.outstanding).toBe(0n);
    expect(g.recoveredRatio).toBe(1);
  });

  it("never returns a negative outstanding if recovery somehow exceeds cost", () => {
    const g = decodeGraduatedFees(record(100n, 250n));
    expect(g.outstanding).toBe(0n);
    expect(g.recoveredRatio).toBe(1);
  });

  it("treats a zero-cost record as repaid rather than dividing by zero", () => {
    const g = decodeGraduatedFees(record(0n, 0n));
    expect(g.recoveredRatio).toBe(1);
    expect(g.outstanding).toBe(0n);
  });
});

describe("batch read", () => {
  const mints = () =>
    Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());

  it("reads every mint in ONE round trip and keeps burned coins distinguishable", async () => {
    const [locked, burned, alsoLocked] = mints() as [string, string, string];
    let calls = 0;
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        calls++;
        expect(keys).toHaveLength(3);
        return [{ data: record(24_838_720n, 0n) }, null, { data: record(100n, 100n) }];
      },
    } as unknown as Connection;

    const out = await fetchGraduatedFeesMap(connection, [locked, burned, alsoLocked]);
    expect(calls).toBe(1);
    // A burned coin is present-with-null, never absent: the caller has to be
    // able to say "burned" without it looking like the read never happened.
    expect(out.has(burned)).toBe(true);
    expect(out.get(burned)).toBeNull();
    expect(out.get(locked)!.outstanding).toBe(24_838_720n);
    expect(out.get(alsoLocked)!.outstanding).toBe(0n);
  });

  it("chunks past the 100-account getMultipleAccounts ceiling", async () => {
    const many = Array.from(
      { length: 230 },
      () => Keypair.generate().publicKey.toBase58(),
    );
    const sizes: number[] = [];
    const connection = {
      getMultipleAccountsInfo: async (keys: PublicKey[]) => {
        sizes.push(keys.length);
        return keys.map(() => null);
      },
    } as unknown as Connection;

    const out = await fetchGraduatedFeesMap(connection, many);
    expect(sizes).toEqual([100, 100, 30]);
    expect(out.size).toBe(230);
  });

  it("does no RPC at all for an empty list", async () => {
    const connection = {
      getMultipleAccountsInfo: async () => {
        throw new Error("should not be called");
      },
    } as unknown as Connection;
    expect((await fetchGraduatedFeesMap(connection, [])).size).toBe(0);
  });
});
