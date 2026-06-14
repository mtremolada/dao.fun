/**
 * Enhanced DEX Listing — content commitment (spec 6.x, D-036).
 *
 * A launch may opt into a DEX Screener "Enhanced Token Info" page (banner +
 * socials + description). The DAO commits to that content at launch by hashing
 * it here; the hash is pinned on-chain as the reimbursement proposal's
 * descriptionLink (the D-017 pattern) and in the launch artifact, so a
 * community member who later submits the listing can only submit the EXACT
 * committed content — any change to a CID/social/description changes the hash
 * and the verifier's badge turns red (same tamper-evidence as INV-9 /
 * computeInstructionSetHash). Banner/logo are referenced by content-addressed
 * IPFS CIDs, so pinning the CID pins the image bytes.
 *
 * Browser+node-safe (@noble/hashes, not node:crypto — webpack can't bundle
 * node:crypto for the static client build, see vsr.ts) because the launch form
 * computes the commitment client-side and the backend/verifier recomputes it:
 * both MUST use this same function.
 */
import { sha256 } from "@noble/hashes/sha256";

/** The only DEX target in scope (D-036). */
export type EnhancedListingTarget = "dex-screener";

/**
 * The content the DAO commits to. Banner/logo are IPFS CIDs (content-addressed,
 * so pinning the CID pins the image bytes). All fields are plain strings so this
 * module stays free of chain deps and bundles into the client.
 */
export interface EnhancedListingContent {
  bannerCid: string;
  logoCid?: string;
  description: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  discord?: string;
}

const COMMITMENT_DOMAIN = "daofun:enhanced-listing:v1";

// Fixed field order — the canonical serialization depends ONLY on values, not
// on object key declaration order, so proposer and verifier always agree.
const CONTENT_FIELDS: readonly (keyof EnhancedListingContent)[] = [
  "bannerCid",
  "logoCid",
  "description",
  "twitter",
  "telegram",
  "website",
  "discord",
];

/**
 * sha256 over a length-framed canonical serialization (domain tag + each field
 * in fixed order, every part prefixed by its u32-LE byte length so "ab"+"" can
 * never collide with "a"+"b"). Missing optional fields canonicalize as empty.
 */
export function computeContentCommitment(
  content: EnhancedListingContent,
): string {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const framed = (s: string) => {
    const body = enc.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, body.length, true);
    parts.push(len, body);
  };
  framed(COMMITMENT_DOMAIN);
  for (const field of CONTENT_FIELDS) framed(content[field] ?? "");

  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return Buffer.from(sha256(buf)).toString("hex");
}
