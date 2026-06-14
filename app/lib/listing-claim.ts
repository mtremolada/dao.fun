/**
 * Enhanced-listing reimbursement claim (D-037) — client-side, no server. The
 * PAYER submits BOTH proofs themselves:
 *
 *   1. the WALLET SIGNATURE over the canonical claim challenge (their wallet
 *      signs a message — proof they control the wallet that paid, and the
 *      payout is bound to it), and
 *   2. the PAYMENT TX HASH they type in (the on-chain transfer to re-verify).
 *
 * The tx hash alone is worthless (it is public on-chain); it only counts paired
 * with the signature. We assemble the canonical ClaimSubmission, verify the
 * signature locally for instant feedback, and — when a verifier URL is given —
 * POST it for the authoritative on-chain payment + delivery checks. The pure
 * pieces (challenge, encode, verify) come from the sdk SOURCE subpath, which
 * carries no node:crypto and so bundles into the static client (like vote.ts).
 */
import { PublicKey } from "@solana/web3.js";
import {
  buildClaimChallenge,
  encodeClaimSubmission,
  verifyClaimSubmissionSignature,
  type ClaimSubmission,
  type EnhancedListingClaim,
} from "@daofun/sdk/enhanced-listing-claim";
import type { WalletSender } from "./wallet-sender";

const HEX_64 = /^[0-9a-f]{64}$/i;

export interface ClaimInput {
  /** The launched token mint (DEX Screener is keyed by it). */
  mint: string;
  /** The content the DAO committed to at launch (sha256 hex). */
  contentCommitment: string;
  /** Capped reimbursement in lamports (decimal string). */
  claimedUsdc: string;
  /** From the DEX Screener order; binds the claim to a moment in time. */
  paymentTimestamp: number;
  /** The payer-supplied on-chain payment transaction signature. */
  paymentTxSig: string;
}

export type ClaimPhase = "signing" | "verifying" | "done" | "error";

export interface ClaimState {
  phase: ClaimPhase;
  /** Local ed25519 check: the connected wallet IS the bound payer. */
  signatureValid?: boolean;
  /** The assembled submission (both proofs) to lodge / POST. */
  submission?: ClaimSubmission;
  /** Authoritative verdict, present only when a verifier URL was given. */
  serverVerdict?: { ok: boolean; reasons: string[] };
  error?: string;
}

export interface SubmitClaimOpts {
  sender: WalletSender;
  onState?: (s: ClaimState) => void;
  /** Optional backend verifier (POST the submission for on-chain checks). */
  verifyUrl?: string;
  /** Test seam: override the message signer + the fetch impl. */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
}

/** Build the bound claim from the payer-entered inputs + the connected wallet. */
function toClaim(input: ClaimInput, payer: string): EnhancedListingClaim {
  const mint = new PublicKey(input.mint); // throws on a bad mint
  if (!HEX_64.test(input.contentCommitment)) {
    throw new Error("content commitment must be 64 hex characters");
  }
  const claimedUsdc = BigInt(input.claimedUsdc); // throws on non-numeric
  if (claimedUsdc <= 0n) throw new Error("amount must be positive");
  if (!Number.isInteger(input.paymentTimestamp) || input.paymentTimestamp <= 0) {
    throw new Error("payment timestamp must be a positive integer");
  }
  const paymentTxSig = input.paymentTxSig.trim();
  if (paymentTxSig.length === 0) throw new Error("enter the payment transaction signature");
  return {
    mint,
    contentCommitment: input.contentCommitment,
    payer: new PublicKey(payer),
    claimedUsdc,
    paymentTxSig,
    paymentTimestamp: input.paymentTimestamp,
  };
}

/**
 * Sign the claim with the connected wallet and assemble the submission. The
 * wallet's own signMessage is used unless a test override is supplied. Returns
 * (and streams via onState) the terminal state.
 */
export async function submitListingClaim(
  input: ClaimInput,
  opts: SubmitClaimOpts,
): Promise<ClaimState> {
  const step = (s: ClaimState) => {
    opts.onState?.(s);
    return s;
  };
  try {
    const claim = toClaim(input, opts.sender.address);
    const challenge = new TextEncoder().encode(buildClaimChallenge(claim));

    const sign = opts.signMessage ?? opts.sender.signMessage?.bind(opts.sender);
    if (!sign) {
      throw new Error("this wallet cannot sign messages — use Phantom or Solflare");
    }
    step({ phase: "signing" });
    const signature = await sign(challenge);

    const submission = encodeClaimSubmission(claim, signature);
    const signatureValid = verifyClaimSubmissionSignature(submission);

    if (!opts.verifyUrl) {
      return step({ phase: "done", submission, signatureValid });
    }

    step({ phase: "verifying", submission, signatureValid });
    const fetchImpl = opts.fetchImpl ?? fetch;
    const res = await fetchImpl(opts.verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(submission),
    });
    if (!res.ok) throw new Error(`verifier responded ${res.status}`);
    const verdict = (await res.json()) as { ok: boolean; reasons?: string[] };
    return step({
      phase: "done",
      submission,
      signatureValid,
      serverVerdict: { ok: Boolean(verdict.ok), reasons: verdict.reasons ?? [] },
    });
  } catch (e) {
    return step({ phase: "error", error: (e as Error).message });
  }
}
