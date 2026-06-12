/**
 * Canonical instruction-set hash — INV-9's anchor (spec 12.3).
 *
 * Computed over the canonical serialization of the instruction set in
 * EXECUTION ORDER, covering program ids, account keys with their
 * signer/writable flags, and instruction data — so any tamper or reorder
 * changes the hash and the UI badge turns red (INV-9/10). Lives in the
 * sdk because both the proposer (descriptionLink, D-017) and the verifier
 * (artifact store, chain reader) must use the SAME function.
 */
import { createHash } from "node:crypto";
import type { TransactionInstruction } from "@solana/web3.js";

export function computeInstructionSetHash(
  ixs: TransactionInstruction[],
): string {
  const h = createHash("sha256");
  for (const ix of ixs) {
    h.update(ix.programId.toBuffer());
    // AUDIT F-4: 4-byte LE length prefix (matching the data-length field
    // below) so the account count cannot wrap and two distinct instruction
    // sets can never collide via a >=256-account instruction. Length-prefixed
    // throughout keeps the serialization canonical and injective.
    const keyCount = Buffer.alloc(4);
    keyCount.writeUInt32LE(ix.keys.length);
    h.update(keyCount);
    for (const meta of ix.keys) {
      h.update(meta.pubkey.toBuffer());
      h.update(Buffer.from([meta.isSigner ? 1 : 0, meta.isWritable ? 1 : 0]));
    }
    const len = Buffer.alloc(4);
    len.writeUInt32LE(ix.data.length);
    h.update(len);
    h.update(ix.data);
  }
  return h.digest("hex");
}
