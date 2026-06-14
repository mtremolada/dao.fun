/**
 * Enhanced-listing backend sources (D-036) — written before implementation.
 * Orders fetch -> delivery state, and the on-chain payment verifier that
 * resolves competing claims (payer is a signer, amount, time; the destination
 * is surfaced but NOT gated, D-038). Fakes injected, like holder-snapshot.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  DexScreenerOrdersSource,
  ListingClaimVerifier,
  OnChainPaymentVerifier,
  toListingClaimVerificationWire,
} from "../src/enhanced-listing-source";
import {
  buildClaimChallenge,
  encodeClaimSubmission,
  type EnhancedListingClaim,
} from "@daofun/sdk";

// ed25519-sign the challenge from a Solana keypair seed using node:crypto, so
// this package needs no tweetnacl dep (the verifier's own tweetnacl path checks
// it). secretKey is seed(32) || pubkey(32); PKCS8-wrap the seed for crypto.
function edSign(message: string, secretKey: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(secretKey.slice(0, 32)),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return new Uint8Array(cryptoSign(null, Buffer.from(message, "utf8"), key));
}

const mint = Keypair.generate().publicKey;

function ordersFetch(
  status: number,
  body: unknown,
  capture?: (url: string) => void,
): typeof fetch {
  return (async (url: unknown) => {
    capture?.(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

describe("DexScreenerOrdersSource", () => {
  it("queries /orders/v1/solana/{mint} and maps an approved tokenProfile to live", async () => {
    let seen = "";
    const src = new DexScreenerOrdersSource({
      baseUrl: "https://api.test",
      fetchImpl: ordersFetch(
        200,
        [{ type: "tokenProfile", status: "approved", paymentTimestamp: 1700 }],
        (u) => (seen = u),
      ),
    });
    const state = await src.deliveryState(mint);
    expect(seen).toBe(`https://api.test/orders/v1/solana/${mint.toBase58()}`);
    expect(state.live).toBe(true);
    expect(state.paymentTimestamp).toBe(1700);
  });

  it("ignores non-profile products and malformed records (fail closed)", async () => {
    const src = new DexScreenerOrdersSource({
      fetchImpl: ordersFetch(200, [
        { type: "tokenAd", status: "approved" }, // approved ad is not a listing
        { type: "tokenProfile", status: "weird" }, // bad status -> dropped
        { type: "tokenProfile", status: "processing" }, // pending
        { nonsense: true },
      ]),
    });
    const state = await src.deliveryState(mint);
    expect(state.live).toBe(false);
    expect(state.pending).toBe(true);
  });

  it("throws on non-2xx and on a non-array body", async () => {
    await expect(
      new DexScreenerOrdersSource({
        fetchImpl: ordersFetch(429, []),
      }).deliveryState(mint),
    ).rejects.toThrow(/HTTP 429/);
    await expect(
      new DexScreenerOrdersSource({
        fetchImpl: ordersFetch(200, { not: "array" }),
      }).deliveryState(mint),
    ).rejects.toThrow(/array/);
  });
});

function makeClaim(over: Partial<EnhancedListingClaim> = {}): EnhancedListingClaim {
  return {
    mint,
    contentCommitment: "a".repeat(64),
    payer: Keypair.generate().publicKey,
    claimedLamports: 1_500_000_000n,
    paymentTxSig: "sig",
    paymentTimestamp: 1_800_000_000,
    ...over,
  };
}

interface TxOpts {
  payer: PublicKey;
  signer?: boolean;
  outflowLamports?: number;
  blockTime?: number | null;
  err?: unknown;
  /** Accounts (other than the payer) that GAIN lamports — the counterparties. */
  recipients?: { key: PublicKey; lamports: number }[];
  usdc?: { mint: PublicKey; owner: PublicKey; pre: string; post: string };
}

function fakeConn(opts: TxOpts | null): Connection {
  return {
    async getParsedTransaction() {
      if (opts === null) return null;
      const outflow = opts.outflowLamports ?? 1_600_000_000;
      const recipients = opts.recipients ?? [];
      return {
        blockTime: opts.blockTime === undefined ? 1_800_000_000 : opts.blockTime,
        meta: {
          err: opts.err ?? null,
          preBalances: [outflow + 5_000, ...recipients.map(() => 0)],
          postBalances: [5_000, ...recipients.map((r) => r.lamports)],
          preTokenBalances: opts.usdc
            ? [
                {
                  owner: opts.usdc.owner.toBase58(),
                  mint: opts.usdc.mint.toBase58(),
                  uiTokenAmount: { amount: opts.usdc.pre },
                },
              ]
            : [],
          postTokenBalances: opts.usdc
            ? [
                {
                  owner: opts.usdc.owner.toBase58(),
                  mint: opts.usdc.mint.toBase58(),
                  uiTokenAmount: { amount: opts.usdc.post },
                },
              ]
            : [],
          innerInstructions: [],
        },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: opts.payer, signer: opts.signer ?? true, writable: true },
              ...recipients.map((r) => ({ pubkey: r.key, signer: false, writable: true })),
            ],
            instructions: [],
          },
        },
      };
    },
  } as unknown as Connection;
}

describe("OnChainPaymentVerifier", () => {
  it("accepts a SOL payment signed by the payer, above the floor, in the time window", async () => {
    const claim = makeClaim();
    const v = new OnChainPaymentVerifier(
      fakeConn({ payer: claim.payer, outflowLamports: 1_600_000_000 }),
      { minPaymentLamports: 1_000_000_000n },
    );
    const r = await v.verify(claim);
    expect(r.ok).toBe(true);
    expect(r.signerMatches).toBe(true);
    expect(r.amountSufficient).toBe(true);
    expect(r.withinTimeWindow).toBe(true);
    expect(r.observedOutflowLamports).toBe(1_600_000_000n);
  });

  it("rejects when the payer is present but not a signer (the redirect/impostor guard)", async () => {
    const claim = makeClaim();
    const r = await new OnChainPaymentVerifier(
      fakeConn({ payer: claim.payer, signer: false }),
      { minPaymentLamports: 1_000_000_000n },
    ).verify(claim);
    expect(r.ok).toBe(false);
    expect(r.signerMatches).toBe(false);
  });

  it("rejects when the payer is not even in the transaction (pointing at someone else's tx)", async () => {
    const claim = makeClaim();
    const r = await new OnChainPaymentVerifier(
      fakeConn({ payer: Keypair.generate().publicKey }), // a different wallet's tx
      { minPaymentLamports: 1_000_000_000n },
    ).verify(claim);
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toMatch(/not an account/);
  });

  it("rejects amounts below the floor and times outside the window", async () => {
    const claim = makeClaim();
    const low = await new OnChainPaymentVerifier(
      fakeConn({ payer: claim.payer, outflowLamports: 500_000_000 }),
      { minPaymentLamports: 1_000_000_000n },
    ).verify(claim);
    expect(low.ok).toBe(false);
    expect(low.amountSufficient).toBe(false);

    const late = await new OnChainPaymentVerifier(
      fakeConn({
        payer: claim.payer,
        outflowLamports: 1_600_000_000,
        blockTime: claim.paymentTimestamp + 100_000,
      }),
      { minPaymentLamports: 1_000_000_000n, timeWindowSeconds: 3600 },
    ).verify(claim);
    expect(late.ok).toBe(false);
    expect(late.withinTimeWindow).toBe(false);
  });

  it("rejects a missing or on-chain-failed tx", async () => {
    const claim = makeClaim();
    const notFound = await new OnChainPaymentVerifier(fakeConn(null), {
      minPaymentLamports: 1n,
    }).verify(claim);
    expect(notFound.ok).toBe(false);
    expect(notFound.reasons.join()).toMatch(/not found/);

    const failed = await new OnChainPaymentVerifier(
      fakeConn({ payer: claim.payer, err: { InstructionError: [0, "Custom"] } }),
      { minPaymentLamports: 1n },
    ).verify(claim);
    expect(failed.ok).toBe(false);
    expect(failed.reasons.join()).toMatch(/failed on-chain/);
  });

  it("accepts a USDC-SPL payment via token-balance deltas on the payer", async () => {
    const claim = makeClaim();
    const usdcMint = Keypair.generate().publicKey;
    const r = await new OnChainPaymentVerifier(
      fakeConn({
        payer: claim.payer,
        outflowLamports: 0,
        usdc: {
          mint: usdcMint,
          owner: claim.payer,
          pre: "300000000",
          post: "1000000",
        },
      }),
      { usdcMint, minPaymentUsdc: 299_000_000n },
    ).verify(claim);
    expect(r.ok).toBe(true);
    expect(r.amountSufficient).toBe(true);
    expect(r.observedUsdcOutflow).toBe(299_000_000n);
  });

  it("surfaces the payment recipients (informational) but never gates ok on the destination (D-038)", async () => {
    const claim = makeClaim();
    const helio = Keypair.generate().publicKey; // some unknown processor address
    const small = Keypair.generate().publicKey;

    const r = await new OnChainPaymentVerifier(
      fakeConn({
        payer: claim.payer,
        outflowLamports: 1_600_000_000,
        recipients: [
          { key: small, lamports: 5_000 },
          { key: helio, lamports: 1_595_000_000 },
        ],
      }),
      { minPaymentLamports: 1_000_000_000n },
    ).verify(claim);

    // the destination is arbitrary/unknown, yet ownership + amount + time pass
    expect(r.ok).toBe(true);
    // recipients are surfaced, largest first, for the community to check
    expect(r.recipients.map((x) => x.address)).toEqual([
      helio.toBase58(),
      small.toBase58(),
    ]);
    expect(r.recipients[0]!.lamports).toBe(1_595_000_000n);
  });
});

describe("ListingClaimVerifier (payer submits both signature + tx hash)", () => {
  // a payer wallet that actually signs the bound challenge
  const doer = Keypair.generate();
  const signedClaim = (over: Partial<EnhancedListingClaim> = {}) => {
    const claim = makeClaim({ payer: doer.publicKey, paymentTxSig: "1".repeat(88), ...over });
    const signature = edSign(buildClaimChallenge(claim), doer.secretKey);
    return { claim, submission: encodeClaimSubmission(claim, signature) };
  };

  const liveOrders = () =>
    new DexScreenerOrdersSource({
      fetchImpl: ordersFetch(200, [
        { type: "tokenProfile", status: "approved", paymentTimestamp: 1700 },
      ]),
    });
  const goodPayment = (claim: EnhancedListingClaim) =>
    new OnChainPaymentVerifier(
      fakeConn({ payer: claim.payer, outflowLamports: 1_600_000_000 }),
      { minPaymentLamports: 1_000_000_000n },
    );

  it("ok only when ownership + payment + delivery all hold", async () => {
    const { claim, submission } = signedClaim();
    const r = await new ListingClaimVerifier(
      liveOrders(),
      goodPayment(claim),
    ).verifyClaim(submission);
    expect(r.ok).toBe(true);
    expect(r.signatureValid).toBe(true);
    expect(r.payment?.ok).toBe(true);
    expect(r.delivery?.live).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("fails closed on a malformed submission (no on-chain/network calls)", async () => {
    let touched = false;
    const orders = new DexScreenerOrdersSource({
      fetchImpl: ordersFetch(200, [], () => (touched = true)),
    });
    const r = await new ListingClaimVerifier(
      orders,
      goodPayment(makeClaim({ payer: doer.publicKey })),
    ).verifyClaim({ payer: "not-a-key" });
    expect(r.ok).toBe(false);
    expect(r.payment).toBeNull();
    expect(r.delivery).toBeNull();
    expect(r.reasons.join()).toMatch(/claim submission/);
    expect(touched).toBe(false);
  });

  it("rejects a forged signature even when payment + delivery look fine", async () => {
    const { claim, submission } = signedClaim();
    // re-sign with a different wallet but keep the bound payer => signature invalid
    const impostor = edSign(buildClaimChallenge(claim), Keypair.generate().secretKey);
    const forged = { ...submission, signatureBase64: Buffer.from(impostor).toString("base64") };
    const r = await new ListingClaimVerifier(
      liveOrders(),
      goodPayment(claim),
    ).verifyClaim(forged);
    expect(r.ok).toBe(false);
    expect(r.signatureValid).toBe(false);
    expect(r.reasons.join()).toMatch(/signature/);
  });

  it("rejects when the listing is not live (pending) and surfaces payment reasons", async () => {
    const { claim, submission } = signedClaim();
    const pendingOrders = new DexScreenerOrdersSource({
      fetchImpl: ordersFetch(200, [{ type: "tokenProfile", status: "processing" }]),
    });
    const r = await new ListingClaimVerifier(pendingOrders, goodPayment(claim)).verifyClaim(
      submission,
    );
    expect(r.ok).toBe(false);
    expect(r.signatureValid).toBe(true);
    expect(r.reasons.join()).toMatch(/pending/);
  });

  it("serializes bigint payment fields to strings for the wire", async () => {
    const { claim, submission } = signedClaim();
    const r = await new ListingClaimVerifier(liveOrders(), goodPayment(claim)).verifyClaim(
      submission,
    );
    const wire = toListingClaimVerificationWire(r);
    expect(wire.payment?.observedOutflowLamports).toBe("1600000000");
    expect(typeof wire.payment?.observedUsdcOutflow).toBe("string");
    expect(() => JSON.stringify(wire)).not.toThrow();
  });
});
