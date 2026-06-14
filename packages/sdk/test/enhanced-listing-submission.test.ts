/**
 * Payer-submitted claim contract (D-037) — the payer submits BOTH the wallet
 * signature and the payment tx hash themselves. decodeClaimSubmission is the
 * load-bearing gate: it must fail closed on any malformed/missing field (every
 * field is bound into the signed challenge, so a lenient decode would let an
 * unsigned value slip past verification) and it must REQUIRE both proofs.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  buildClaimChallenge,
  decodeClaimSubmission,
  encodeClaimSubmission,
  verifyClaimSignature,
  verifyClaimSubmissionSignature,
  type ClaimSubmission,
  type EnhancedListingClaim,
} from "../src/enhanced-listing-claim";

const payer = Keypair.generate();

function makeClaim(over: Partial<EnhancedListingClaim> = {}): EnhancedListingClaim {
  return {
    mint: Keypair.generate().publicKey,
    contentCommitment: "a".repeat(64),
    payer: payer.publicKey,
    claimedUsdc: 1_500_000_000n,
    paymentTxSig: "1".repeat(88),
    paymentTimestamp: 1_800_000_000,
    ...over,
  };
}

function sign(claim: EnhancedListingClaim, signer = payer): Uint8Array {
  return nacl.sign.detached(
    new TextEncoder().encode(buildClaimChallenge(claim)),
    signer.secretKey,
  );
}

function submission(over: Partial<ClaimSubmission> = {}): ClaimSubmission {
  const claim = makeClaim();
  return { ...encodeClaimSubmission(claim, sign(claim)), ...over };
}

describe("encode/decodeClaimSubmission round-trip", () => {
  it("preserves every bound field and a verifiable signature", () => {
    const claim = makeClaim();
    const wire = encodeClaimSubmission(claim, sign(claim));
    const { claim: out, signature } = decodeClaimSubmission(wire);

    expect(out.mint.equals(claim.mint)).toBe(true);
    expect(out.payer.equals(claim.payer)).toBe(true);
    expect(out.contentCommitment).toBe(claim.contentCommitment);
    expect(out.claimedUsdc).toBe(claim.claimedUsdc);
    expect(out.paymentTxSig).toBe(claim.paymentTxSig);
    expect(out.paymentTimestamp).toBe(claim.paymentTimestamp);
    expect(verifyClaimSignature(out, signature)).toBe(true);
  });

  it("encodeClaimSubmission rejects a non-64-byte signature", () => {
    expect(() => encodeClaimSubmission(makeClaim(), new Uint8Array(10))).toThrow(
      /64 bytes/,
    );
  });
});

describe("decodeClaimSubmission requires BOTH proofs and fails closed", () => {
  it("rejects a submission missing the wallet signature", () => {
    const { signatureBase64: _omit, ...noSig } = submission();
    expect(() => decodeClaimSubmission(noSig)).toThrow(/signatureBase64/);
  });

  it("rejects a submission missing the payment tx hash", () => {
    const { paymentTxSig: _omit, ...noTx } = submission();
    expect(() => decodeClaimSubmission(noTx)).toThrow(/paymentTxSig/);
  });

  it("rejects non-object input", () => {
    expect(() => decodeClaimSubmission(null)).toThrow(/object/);
    expect(() => decodeClaimSubmission("nope")).toThrow(/object/);
  });

  it("rejects malformed pubkeys, commitment, amount, timestamp, tx sig, signature", () => {
    expect(() => decodeClaimSubmission(submission({ mint: "not-a-key" }))).toThrow(
      /mint/,
    );
    expect(() => decodeClaimSubmission(submission({ payer: "" }))).toThrow(/payer/);
    expect(() =>
      decodeClaimSubmission(submission({ contentCommitment: "xyz" })),
    ).toThrow(/contentCommitment/);
    expect(() =>
      decodeClaimSubmission(submission({ claimedUsdc: "0" })),
    ).toThrow(/positive/);
    expect(() =>
      decodeClaimSubmission(submission({ claimedUsdc: "1.5" })),
    ).toThrow(/decimal/);
    expect(() =>
      decodeClaimSubmission(submission({ paymentTimestamp: -1 })),
    ).toThrow(/paymentTimestamp/);
    expect(() =>
      decodeClaimSubmission(submission({ paymentTimestamp: 1.5 })),
    ).toThrow(/paymentTimestamp/);
    // a tx sig carrying a newline would corrupt the canonical challenge
    expect(() =>
      decodeClaimSubmission(submission({ paymentTxSig: "abc\nreimburse-to: x" })),
    ).toThrow(/paymentTxSig/);
    expect(() =>
      decodeClaimSubmission(submission({ signatureBase64: "!!!notb64" })),
    ).toThrow(/signatureBase64/);
    expect(() =>
      decodeClaimSubmission(
        submission({ signatureBase64: Buffer.alloc(10).toString("base64") }),
      ),
    ).toThrow(/64 bytes/);
  });
});

describe("verifyClaimSubmissionSignature (client-side ownership feedback)", () => {
  it("is true for a submission signed by the bound payer", () => {
    expect(verifyClaimSubmissionSignature(submission())).toBe(true);
  });

  it("is false when another wallet signed (impostor) and never throws on garbage", () => {
    const claim = makeClaim();
    const forged = encodeClaimSubmission(claim, sign(claim, Keypair.generate()));
    expect(verifyClaimSubmissionSignature(forged)).toBe(false);
    expect(verifyClaimSubmissionSignature({})).toBe(false);
    expect(verifyClaimSubmissionSignature(null)).toBe(false);
  });

  it("is false when a bound field is altered after signing (tamper-evident)", () => {
    const claim = makeClaim();
    const wire = encodeClaimSubmission(claim, sign(claim));
    // inflate the amount: the signature no longer covers the wire claim
    expect(
      verifyClaimSubmissionSignature({ ...wire, claimedUsdc: "9999999999" }),
    ).toBe(false);
  });
});
