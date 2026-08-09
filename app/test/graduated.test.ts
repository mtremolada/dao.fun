/**
 * The one thing this decoder must never do is render a BURNED coin as a
 * zeroed fee stream — devnet burns every coin, so "no record" is the common
 * case, not an error. The rest is making sure the recovery number, which is
 * the only figure a creator will read as a promise, cannot lie.
 */
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { decodeGraduatedFees } from "../lib/graduated";

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
