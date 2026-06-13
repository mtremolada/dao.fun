/**
 * Byte-exactness pin for the vendored SHA-256 (D-033). node:crypto is the
 * oracle: the vendored implementation must agree with it on every input, or
 * the INV-9 hash, the Jito merkle root, the Squads buffer pin, and every
 * anchor discriminator would silently diverge from the deployed programs.
 */
import { describe, expect, it } from "vitest";
import { createHash as nodeCreateHash } from "node:crypto";
import { createHash, sha256 } from "../src/sha256";

function nodeHex(data: Uint8Array | string): string {
  return nodeCreateHash("sha256").update(data).digest("hex");
}

describe("vendored sha256", () => {
  it("matches the published FIPS vectors", () => {
    expect(createHash("sha256").update("").digest("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(createHash("sha256").update("abc").digest("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // 56 bytes -> forces a second padding block (length straddles the boundary)
    expect(
      createHash("sha256")
        .update("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
        .digest("hex"),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("matches node:crypto on the exact anchor-discriminator strings", () => {
    for (const name of [
      "global:create_registrar",
      "global:configure_voting_mint",
      "global:create_voter",
      "global:create_deposit_entry",
      "global:deposit",
      "global:withdraw",
      "global:update_voter_weight_record",
      "global:close_deposit_entry",
      "global:close_voter",
      "global:new_distributor",
      "global:new_claim",
      "global:clawback",
    ]) {
      expect(createHash("sha256").update(`${name}`).digest("hex")).toBe(
        nodeHex(name),
      );
    }
  });

  it("matches node:crypto across all small lengths (block boundaries)", () => {
    for (let len = 0; len <= 200; len++) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        nodeHex(bytes),
      );
    }
  });

  it("matches node:crypto under chained multi-chunk updates", () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = Buffer.from("the quick brown fox", "utf8");
    const c = new Uint8Array(100).fill(0xab);
    const mine = createHash("sha256").update(a).update(b).update(c).digest();
    const oracle = nodeCreateHash("sha256")
      .update(a)
      .update(b)
      .update(c)
      .digest();
    expect(mine.equals(oracle)).toBe(true);
  });

  it("digest() returns a 32-byte Buffer; .subarray and .equals work", () => {
    const d = createHash("sha256").update("global:deposit").digest();
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(32);
    const disc = d.subarray(0, 8);
    expect(disc.length).toBe(8);
    expect(disc.equals(nodeHex("global:deposit") // hex string
      ? Buffer.from(nodeHex("global:deposit"), "hex").subarray(0, 8)
      : Buffer.alloc(8))).toBe(true);
  });

  it("sha256() convenience folds parts identically to a piecewise hash", () => {
    const parts = [Buffer.from([0]), Buffer.from("payload"), new Uint8Array([9, 9])];
    const folded = sha256(...parts);
    const oracle = nodeCreateHash("sha256");
    for (const p of parts) oracle.update(p);
    expect(folded.equals(oracle.digest())).toBe(true);
  });
});
