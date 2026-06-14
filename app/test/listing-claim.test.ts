/**
 * Enhanced-listing claim flow (D-037): the payer submits BOTH the wallet
 * signature and the payment tx hash. We assert the flow assembles a canonical
 * submission carrying both, verifies the signature locally (true only when the
 * connected wallet IS the bound payer), POSTs to a verifier when given, and
 * fails closed on bad input / a wallet that can't sign messages.
 *
 * Signs with node:crypto from the keypair seed (this package has no tweetnacl
 * dep; the sdk's verify path checks it), via the flow's signMessage seam.
 */
import { describe, expect, it } from "vitest";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { submitListingClaim, type ClaimInput } from "../lib/listing-claim";
import type { WalletSender } from "../lib/wallet-sender";

function edSign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(secretKey.slice(0, 32)),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return new Uint8Array(cryptoSign(null, Buffer.from(message), key));
}

const payer = Keypair.generate();

const input: ClaimInput = {
  mint: Keypair.generate().publicKey.toBase58(),
  contentCommitment: "a".repeat(64),
  claimedUsdc: "1500000000",
  paymentTimestamp: 1_800_000_000,
  paymentTxSig: "1".repeat(88),
};

function sender(address = payer.publicKey.toBase58()): WalletSender {
  return {
    address,
    async signAndSend() {
      return "unused";
    },
  };
}

const signWith = (kp: Keypair) => (m: Uint8Array) =>
  Promise.resolve(edSign(m, kp.secretKey));

describe("submitListingClaim", () => {
  it("assembles a submission with BOTH proofs and verifies the signature locally", async () => {
    const s = await submitListingClaim(input, {
      sender: sender(),
      signMessage: signWith(payer),
    });
    expect(s.phase).toBe("done");
    expect(s.signatureValid).toBe(true);
    expect(s.submission?.paymentTxSig).toBe(input.paymentTxSig); // the tx hash
    expect(s.submission?.signatureBase64.length).toBeGreaterThan(0); // the signature
    expect(s.submission?.payer).toBe(payer.publicKey.toBase58());
  });

  it("local signature check is FALSE when another wallet signed (impostor)", async () => {
    // connected wallet is `payer`, but a different key produced the signature
    const s = await submitListingClaim(input, {
      sender: sender(),
      signMessage: signWith(Keypair.generate()),
    });
    expect(s.phase).toBe("done");
    expect(s.signatureValid).toBe(false);
  });

  it("POSTs the submission to a verifier and surfaces the verdict", async () => {
    let posted: unknown;
    const s = await submitListingClaim(input, {
      sender: sender(),
      signMessage: signWith(payer),
      verifyUrl: "https://api.test/chain/listing-claims/verify",
      fetchImpl: (async (_url: string, init: { body: string }) => {
        posted = JSON.parse(init.body);
        return new Response(JSON.stringify({ ok: true, reasons: [] }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(s.phase).toBe("done");
    expect(s.serverVerdict?.ok).toBe(true);
    expect((posted as { paymentTxSig: string }).paymentTxSig).toBe(input.paymentTxSig);
    expect((posted as { signatureBase64?: string }).signatureBase64).toBeTruthy();
  });

  it("errors when the verifier rejects the request", async () => {
    const s = await submitListingClaim(input, {
      sender: sender(),
      signMessage: signWith(payer),
      verifyUrl: "https://api.test/verify",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/500/);
  });

  it("fails closed on a bad mint / missing tx hash / unsigned amount", async () => {
    const badMint = await submitListingClaim(
      { ...input, mint: "not-a-key" },
      { sender: sender(), signMessage: signWith(payer) },
    );
    expect(badMint.phase).toBe("error");

    const noTx = await submitListingClaim(
      { ...input, paymentTxSig: "   " },
      { sender: sender(), signMessage: signWith(payer) },
    );
    expect(noTx.phase).toBe("error");
    expect(noTx.error).toMatch(/transaction signature/);

    const badAmount = await submitListingClaim(
      { ...input, claimedUsdc: "0" },
      { sender: sender(), signMessage: signWith(payer) },
    );
    expect(badAmount.phase).toBe("error");
  });

  it("errors clearly when the wallet cannot sign messages", async () => {
    const s = await submitListingClaim(input, { sender: sender() }); // no signMessage
    expect(s.phase).toBe("error");
    expect(s.error).toMatch(/cannot sign messages/);
  });
});
