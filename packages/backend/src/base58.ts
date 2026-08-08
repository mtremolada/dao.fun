/**
 * Minimal base58 decode (Bitcoin alphabet). The launchpad backend needs it to
 * turn getParsedTransaction's base58 instruction data into bytes and to read a
 * base58 keypair; pulling bs58 in as a direct dependency for ~15 lines isn't
 * worth it (the repo's zero-dep bias).
 */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i += 1) MAP[ALPHABET.charCodeAt(i)] = i;

export function base58Decode(input: string): Buffer {
  if (input.length === 0) return Buffer.alloc(0);
  const bytes: number[] = [0];
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const val = code < 128 ? MAP[code]! : -1;
    if (val < 0) throw new Error(`invalid base58 character "${ch}"`);
    let carry = val;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Leading '1's are leading zero bytes.
  for (let k = 0; k < input.length && input[k] === "1"; k += 1) bytes.push(0);
  return Buffer.from(bytes.reverse());
}
