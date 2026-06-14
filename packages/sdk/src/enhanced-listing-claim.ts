/**
 * Enhanced-listing claim verification (spec 6.x, D-036) — the layer that proves
 * a reimbursement claimant controls the wallet that paid for the listing, and
 * that the listing was actually delivered. Written before implementation.
 *
 * Two independent, pure (offline-testable) checks the claim service and the
 * voter UI both run — the network half (the DEX Screener fetch) lives in the
 * backend behind an adapter, like the holder-snapshot source (snapshot.ts):
 *
 *  1. PAYER OWNERSHIP — verifyClaimSignature: the doer signs a canonical
 *     challenge with the wallet they paid DEX Screener from. The challenge
 *     BINDS the payout recipient, the amount, the mint, the committed content
 *     and the payment timestamp, so the signature is useless to anyone else and
 *     cannot be replayed against a different token, amount, or payout address
 *     (closes the redirect/inflate/reuse vectors). The reimbursement goes to
 *     the signer, so proving ownership also locks the payout to the payer.
 *
 *  2. DELIVERY — interpretEtiOrders: the DEX Screener Orders API is keyed by
 *     mint and returns one order per product; the enhanced listing is the
 *     `tokenProfile` order, and `approved` means it is paid and live. There is
 *     no order id, amount, or payer in that response, which is exactly why the
 *     payer link is established by signature (1), not by an order number.
 *
 * The amount is still capped on-chain by buildBountyReimbursementIxs (INV-12),
 * so even a flawed claim cannot exceed the committed fee.
 */
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";

export interface EnhancedListingClaim {
  mint: PublicKey;
  /** Commitment of the listing content the DAO pinned at launch. */
  contentCommitment: string;
  /** The wallet that paid DEX Screener — the signer AND the reimbursement recipient. */
  payer: PublicKey;
  /** USDC base units (6dp) requested — the doer's verified DEX Screener payment;
   *  the builder enforces <= the known-cost protocol ceiling. */
  claimedUsdc: bigint;
  /**
   * The claimant's on-chain payment transaction signature. Binding it here is
   * what resolves competing claims: the backend checks this tx was sent FROM
   * `payer` for ~the ETI amount near `paymentTimestamp`, so an impostor who
   * never paid (or who points at someone else's tx) cannot produce a claim
   * that both verifies AND matches an on-chain payment from their own wallet.
   */
  paymentTxSig: string;
  /** From the Orders API; doubles as a nonce + correlation anchor. */
  paymentTimestamp: number;
}

/**
 * The canonical, human-readable message the payer signs with their wallet. Each
 * line binds one field; wallets render it as UTF-8 so the signer sees what they
 * authorize. Any change to a bound field changes the message and breaks the
 * signature — that is the whole security property.
 */
export function buildClaimChallenge(claim: EnhancedListingClaim): string {
  return [
    "daofun: enhanced-listing reimbursement claim",
    `mint: ${claim.mint.toBase58()}`,
    `content: ${claim.contentCommitment}`,
    `reimburse-to: ${claim.payer.toBase58()}`,
    `amount-usdc: ${claim.claimedUsdc.toString()}`,
    `payment-tx: ${claim.paymentTxSig}`,
    `payment-ts: ${claim.paymentTimestamp}`,
  ].join("\n");
}

/** ed25519-verify `signature` over the claim's challenge against the payer key. */
export function verifyClaimSignature(
  claim: EnhancedListingClaim,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) return false;
  const message = new TextEncoder().encode(buildClaimChallenge(claim));
  try {
    return nacl.sign.detached.verify(message, signature, claim.payer.toBytes());
  } catch {
    return false;
  }
}

// --- Payer-submitted claim (the wire form: BOTH proofs, supplied by the payer)

/**
 * What the payer submits THEMSELVES to claim a reimbursement — the bound claim
 * fields plus the two pieces of evidence only the payer can produce:
 *
 *   - `signatureBase64`: the wallet signature over buildClaimChallenge(claim),
 *     proving control of the paying wallet (and locking the payout to it);
 *   - `paymentTxSig`: the on-chain payment transaction hash, re-verified server
 *     side as a real outflow from that same wallet.
 *
 * Neither alone is sufficient: the tx hash is public (anyone could cite it), so
 * it MUST come paired with a signature from the wallet that sent it. Plain JSON
 * (strings + one number) so it crosses the wire and lives in the browser with
 * no chain deps.
 */
export interface ClaimSubmission {
  mint: string;
  contentCommitment: string;
  payer: string;
  claimedUsdc: string;
  paymentTxSig: string;
  paymentTimestamp: number;
  /** base64 ed25519 signature over buildClaimChallenge(claim). */
  signatureBase64: string;
}

const HEX_64 = /^[0-9a-f]{64}$/i;
// base58 alphabet, transaction-signature length band (64 bytes ≈ 86–88 chars;
// kept generous). Excludes whitespace/newlines, which would corrupt the
// newline-delimited canonical challenge.
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function requirePubkey(label: string, v: unknown): PublicKey {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`claim submission: ${label} must be a base58 string`);
  }
  try {
    return new PublicKey(v);
  } catch {
    throw new Error(`claim submission: ${label} is not a valid pubkey`);
  }
}

/**
 * Validate and decode a payer-submitted claim into the claim + raw signature
 * the verifier consumes. Fails CLOSED on the FIRST malformed field — every
 * field is bound into the signed challenge, so a lenient decode would let a
 * caller smuggle an unsigned/altered value past verification. Requires BOTH
 * `paymentTxSig` and `signatureBase64`: the "payer submits both" contract.
 */
export function decodeClaimSubmission(raw: unknown): {
  claim: EnhancedListingClaim;
  signature: Uint8Array;
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("claim submission: expected an object");
  }
  const r = raw as Record<string, unknown>;

  const mint = requirePubkey("mint", r["mint"]);
  const payer = requirePubkey("payer", r["payer"]);

  const contentCommitment = r["contentCommitment"];
  if (typeof contentCommitment !== "string" || !HEX_64.test(contentCommitment)) {
    throw new Error("claim submission: contentCommitment must be 64 hex chars");
  }

  const usdc = r["claimedUsdc"];
  if (typeof usdc !== "string" || !/^\d+$/.test(usdc)) {
    throw new Error("claim submission: claimedUsdc must be a decimal string");
  }
  const claimedUsdc = BigInt(usdc);
  if (claimedUsdc <= 0n) {
    throw new Error("claim submission: claimedUsdc must be positive");
  }

  const paymentTxSig = r["paymentTxSig"];
  if (typeof paymentTxSig !== "string" || !BASE58_SIG.test(paymentTxSig)) {
    throw new Error(
      "claim submission: paymentTxSig must be a base58 transaction signature",
    );
  }

  const paymentTimestamp = r["paymentTimestamp"];
  if (
    typeof paymentTimestamp !== "number" ||
    !Number.isInteger(paymentTimestamp) ||
    paymentTimestamp <= 0
  ) {
    throw new Error(
      "claim submission: paymentTimestamp must be a positive integer",
    );
  }

  const sigB64 = r["signatureBase64"];
  if (typeof sigB64 !== "string" || !BASE64.test(sigB64)) {
    throw new Error("claim submission: signatureBase64 must be base64");
  }
  const signature = new Uint8Array(Buffer.from(sigB64, "base64"));
  if (signature.length !== 64) {
    throw new Error("claim submission: signature must decode to 64 bytes");
  }

  return {
    claim: {
      mint,
      contentCommitment,
      payer,
      claimedUsdc,
      paymentTxSig,
      paymentTimestamp,
    },
    signature,
  };
}

/** Build the wire submission from a claim + the wallet signature over it. */
export function encodeClaimSubmission(
  claim: EnhancedListingClaim,
  signature: Uint8Array,
): ClaimSubmission {
  if (signature.length !== 64) {
    throw new Error("claim submission: signature must be 64 bytes");
  }
  return {
    mint: claim.mint.toBase58(),
    contentCommitment: claim.contentCommitment,
    payer: claim.payer.toBase58(),
    claimedUsdc: claim.claimedUsdc.toString(),
    paymentTxSig: claim.paymentTxSig,
    paymentTimestamp: claim.paymentTimestamp,
    signatureBase64: Buffer.from(signature).toString("base64"),
  };
}

/**
 * Decode + verify the wallet signature only (payer ownership). Never throws —
 * a convenience for instant client-side feedback before the authoritative
 * on-chain payment + delivery checks run server side.
 */
export function verifyClaimSubmissionSignature(raw: unknown): boolean {
  try {
    const { claim, signature } = decodeClaimSubmission(raw);
    return verifyClaimSignature(claim, signature);
  } catch {
    return false;
  }
}

// --- Delivery proof (DEX Screener Orders API shape, keyed by mint) ----------

export type EtiOrderType =
  | "tokenProfile"
  | "communityTakeover"
  | "tokenAd"
  | "trendingBarAd";

export type EtiOrderStatus =
  | "processing"
  | "cancelled"
  | "on-hold"
  | "approved"
  | "rejected";

/** One element of GET /orders/v1/{chainId}/{tokenAddress}. */
export interface EtiOrder {
  type: EtiOrderType;
  status: EtiOrderStatus;
  paymentTimestamp?: number;
}

export interface EtiDeliveryState {
  /** A tokenProfile order is approved — the enhanced listing is live. */
  live: boolean;
  /** A tokenProfile order is processing/on-hold — paid but not yet live. */
  pending: boolean;
  paymentTimestamp?: number;
}

/**
 * Reduce the Orders API array to the enhanced-listing delivery state. Only the
 * `tokenProfile` product counts — an approved ad or trending-bar order is NOT
 * an enhanced listing.
 */
export function interpretEtiOrders(orders: EtiOrder[]): EtiDeliveryState {
  const profiles = orders.filter((o) => o.type === "tokenProfile");
  const approved = profiles.find((o) => o.status === "approved");
  if (approved) {
    return {
      live: true,
      pending: false,
      ...(approved.paymentTimestamp !== undefined
        ? { paymentTimestamp: approved.paymentTimestamp }
        : {}),
    };
  }
  const pending = profiles.find(
    (o) => o.status === "processing" || o.status === "on-hold",
  );
  return {
    live: false,
    pending: Boolean(pending),
    ...(pending?.paymentTimestamp !== undefined
      ? { paymentTimestamp: pending.paymentTimestamp }
      : {}),
  };
}
