/**
 * Dependency-free, synchronous SHA-256 — the isomorphic replacement for
 * `node:crypto`'s `createHash("sha256")` (D-033).
 *
 * Why vendored rather than a polyfill or a new dependency: this hash is a
 * LOAD-BEARING INVARIANT (INV-9 instruction-set hash, the Jito merkle tree,
 * Squads transaction-buffer pins, anchor discriminators). It must produce
 * byte-identical output in Node and the browser with no `node:` scheme that
 * webpack cannot bundle, and with no supply-chain surface under a security
 * invariant. The implementation is the textbook FIPS 180-4 round function;
 * its correctness is pinned byte-for-byte against `node:crypto` in
 * sha256.test.ts AND, end-to-end, against the real on-chain programs in the
 * integration suite (merkle proofs + anchor discriminators) — a wrong hash
 * fails there.
 *
 * The `createHash` export is a drop-in for the exact surface the SDK used:
 * `.update(data)` (chainable), `.digest()` -> Buffer, `.digest("hex")`.
 */
import { Buffer } from "buffer";

// First 32 bits of the fractional parts of the cube roots of the first 64
// primes (FIPS 180-4 §4.2.2).
// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Raw SHA-256 of a byte array, returned as a 32-byte Uint8Array. */
function sha256Bytes(msg: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  // Padding: append 0x80, then zeros, then the 64-bit big-endian bit length,
  // so the total is a multiple of 64 bytes.
  const withOne = msg.length + 1;
  const zeros = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + zeros + 8;
  const buf = new Uint8Array(total);
  buf.set(msg, 0);
  buf[msg.length] = 0x80;
  const bitLen = BigInt(msg.length) * 8n;
  for (let i = 0; i < 8; i++) {
    buf[total - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  }

  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] =
        ((buf[j]! << 24) |
          (buf[j + 1]! << 16) |
          (buf[j + 2]! << 8) |
          buf[j + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const x15 = w[i - 15]!;
      const x2 = w[i - 2]!;
      const s0 = (rotr(x15, 7) ^ rotr(x15, 18) ^ (x15 >>> 3)) >>> 0;
      const s1 = (rotr(x2, 17) ^ rotr(x2, 19) ^ (x2 >>> 10)) >>> 0;
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (hs[i]! >>> 24) & 0xff;
    out[i * 4 + 1] = (hs[i]! >>> 16) & 0xff;
    out[i * 4 + 2] = (hs[i]! >>> 8) & 0xff;
    out[i * 4 + 3] = hs[i]! & 0xff;
  }
  return out;
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new Uint8Array(Buffer.from(data, "utf8"));
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/**
 * Minimal `Hash` matching the subset of node:crypto the SDK relies on. The
 * update inputs are accumulated and hashed on digest() — inputs here are
 * small (instruction data, vault messages), so a one-shot compression is
 * both correct and adequate.
 */
class Sha256Hash {
  private readonly chunks: Uint8Array[] = [];

  update(data: string | Uint8Array | ArrayBuffer): this {
    this.chunks.push(toBytes(data));
    return this;
  }

  digest(): Buffer;
  digest(encoding: "hex"): string;
  digest(encoding?: "hex"): Buffer | string {
    let len = 0;
    for (const c of this.chunks) len += c.length;
    const all = new Uint8Array(len);
    let off = 0;
    for (const c of this.chunks) {
      all.set(c, off);
      off += c.length;
    }
    const out = Buffer.from(sha256Bytes(all));
    return encoding === "hex" ? out.toString("hex") : out;
  }
}

/** Drop-in for `node:crypto`'s createHash, restricted to "sha256". */
export function createHash(algorithm: "sha256"): Sha256Hash {
  if (algorithm !== "sha256") {
    throw new Error(`sha256.createHash: unsupported algorithm "${algorithm}"`);
  }
  return new Sha256Hash();
}

/** One-shot convenience: SHA-256 of the concatenated parts, as a Buffer. */
export function sha256(...parts: (string | Uint8Array)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}
