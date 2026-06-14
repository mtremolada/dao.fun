/**
 * Enhanced-listing claim verification (D-036) — written before implementation.
 * The payer-ownership signature is the load-bearing leg: it proves the claimant
 * controls the wallet that paid, and binds the payout to it.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  buildClaimChallenge,
  interpretEtiOrders,
  verifyClaimSignature,
  type EnhancedListingClaim,
  type EtiOrder,
} from "../src/enhanced-listing-claim";

function makeClaim(
  over: Partial<EnhancedListingClaim> = {},
): EnhancedListingClaim {
  return {
    mint: Keypair.generate().publicKey,
    contentCommitment: "a".repeat(64),
    payer: Keypair.generate().publicKey,
    claimedUsdc: 1_500_000_000n,
    paymentTxSig: "1".repeat(88),
    paymentTimestamp: 1_800_000_000,
    ...over,
  };
}

function sign(claim: EnhancedListingClaim, signer: Keypair): Uint8Array {
  return nacl.sign.detached(
    new TextEncoder().encode(buildClaimChallenge(claim)),
    signer.secretKey,
  );
}

describe("verifyClaimSignature (proves control of the paying wallet)", () => {
  it("verifies a signature made by the payer wallet over the bound claim", () => {
    const doer = Keypair.generate();
    const claim = makeClaim({ payer: doer.publicKey });
    expect(verifyClaimSignature(claim, sign(claim, doer))).toBe(true);
  });

  it("rejects a signature from any other wallet — ownership is the whole point", () => {
    const doer = Keypair.generate();
    const attacker = Keypair.generate();
    const claim = makeClaim({ payer: doer.publicKey });
    // attacker signs the same claim but is not the bound payer
    expect(verifyClaimSignature(claim, sign(claim, attacker))).toBe(false);
  });

  it("is bound to recipient/amount/mint/content/timestamp — tampering any one breaks it", () => {
    const doer = Keypair.generate();
    const claim = makeClaim({ payer: doer.publicKey });
    const sig = sign(claim, doer);
    // redirect the payout to another address
    expect(
      verifyClaimSignature(
        { ...claim, payer: Keypair.generate().publicKey },
        sig,
      ),
    ).toBe(false);
    // inflate the amount after signing
    expect(
      verifyClaimSignature(
        { ...claim, claimedUsdc: claim.claimedUsdc + 1n },
        sig,
      ),
    ).toBe(false);
    // reuse the signature for a different token, content, or payment time
    expect(
      verifyClaimSignature({ ...claim, mint: Keypair.generate().publicKey }, sig),
    ).toBe(false);
    expect(
      verifyClaimSignature({ ...claim, contentCommitment: "b".repeat(64) }, sig),
    ).toBe(false);
    // claim a different payment transaction than the one signed for
    expect(
      verifyClaimSignature({ ...claim, paymentTxSig: "2".repeat(88) }, sig),
    ).toBe(false);
    expect(
      verifyClaimSignature(
        { ...claim, paymentTimestamp: claim.paymentTimestamp + 1 },
        sig,
      ),
    ).toBe(false);
  });

  it("rejects malformed signatures without throwing", () => {
    const claim = makeClaim();
    expect(verifyClaimSignature(claim, new Uint8Array(10))).toBe(false);
    expect(verifyClaimSignature(claim, new Uint8Array(64))).toBe(false); // zeros
  });
});

describe("interpretEtiOrders (delivery proof, keyed by mint)", () => {
  const profile = (
    status: EtiOrder["status"],
    paymentTimestamp?: number,
  ): EtiOrder => ({
    type: "tokenProfile",
    status,
    ...(paymentTimestamp !== undefined ? { paymentTimestamp } : {}),
  });

  it("is live only when a tokenProfile order is approved", () => {
    const s = interpretEtiOrders([profile("approved", 1_799_999_999)]);
    expect(s.live).toBe(true);
    expect(s.pending).toBe(false);
    expect(s.paymentTimestamp).toBe(1_799_999_999);
  });

  it("is pending (not live) while a tokenProfile order is processing or on-hold", () => {
    expect(interpretEtiOrders([profile("processing")])).toMatchObject({
      live: false,
      pending: true,
    });
    expect(interpretEtiOrders([profile("on-hold")])).toMatchObject({
      live: false,
      pending: true,
    });
  });

  it("ignores non-tokenProfile products — an approved ad is not an enhanced listing", () => {
    const s = interpretEtiOrders([
      { type: "tokenAd", status: "approved" },
      { type: "trendingBarAd", status: "approved" },
    ]);
    expect(s.live).toBe(false);
    expect(s.pending).toBe(false);
  });

  it("treats an empty or terminal-only order set as not live", () => {
    expect(interpretEtiOrders([])).toMatchObject({ live: false, pending: false });
    expect(
      interpretEtiOrders([profile("rejected"), profile("cancelled")]),
    ).toMatchObject({ live: false, pending: false });
  });
});
