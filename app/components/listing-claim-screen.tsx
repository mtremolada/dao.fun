"use client";

/**
 * Enhanced-listing reimbursement claim (D-037) — fully client-side. The payer
 * submits BOTH proofs themselves: they paste the on-chain PAYMENT TX HASH and
 * sign the canonical claim challenge with their WALLET. We assemble the
 * canonical submission, verify the signature locally, and (when ?verifyUrl= is
 * given) POST it for the authoritative on-chain payment + delivery checks.
 *
 * The bound claim fields come from query params so a deep link from the launch
 * artifact populates them with no server: ?mint=&content=&amount=&ts=.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { submitListingClaim, type ClaimState } from "../lib/listing-claim";
import { useWallet } from "./wallet-provider";

export function ListingClaimScreen() {
  const q = useSearchParams();
  const mint = q.get("mint") ?? "";
  const contentCommitment = q.get("content") ?? "";
  const claimedLamports = q.get("amount") ?? "";
  const paymentTimestamp = Number(q.get("ts") ?? "");
  const verifyUrl = q.get("verifyUrl") ?? undefined;

  const { sender, account, openModal } = useWallet();
  const [txSig, setTxSig] = useState("");
  const [state, setState] = useState<ClaimState | null>(null);

  const missing =
    !mint || !contentCommitment || !claimedLamports || !paymentTimestamp;

  async function onSubmit() {
    if (!sender) {
      openModal();
      return;
    }
    await submitListingClaim(
      { mint, contentCommitment, claimedLamports, paymentTimestamp, paymentTxSig: txSig },
      { sender, onState: setState, ...(verifyUrl ? { verifyUrl } : {}) },
    );
  }

  const busy =
    state !== null && state.phase !== "done" && state.phase !== "error";

  if (missing) {
    return (
      <>
        <h1>Claim listing reimbursement</h1>
        <p className="errors" data-testid="claim-error">
          Missing claim parameters — open this from your launch
          (?mint=&content=&amount=&ts=).
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Claim listing reimbursement</h1>
      <p className="muted">
        Prove you paid for the enhanced listing: paste your payment transaction
        and sign with the wallet that paid. Both are required.
      </p>

      <p className="muted" style={{ wordBreak: "break-all" }} data-testid="claim-mint">
        Mint: {mint}
      </p>
      <p className="muted" data-testid="claim-amount">
        Reimbursement (lamports): {claimedLamports}
      </p>

      {!sender ? (
        <>
          <p className="muted">Connect the wallet that paid to sign your claim.</p>
          <button
            className="button"
            type="button"
            data-testid="claim-connect"
            onClick={openModal}
          >
            Connect wallet
          </button>
        </>
      ) : (
        <p className="muted" data-testid="claim-wallet">
          Signing as: {account?.address}
        </p>
      )}

      <h2>Payment transaction</h2>
      <input
        className="input"
        type="text"
        placeholder="Payment transaction signature"
        data-testid="claim-txhash"
        value={txSig}
        onChange={(e) => setTxSig(e.target.value)}
        style={{ width: "100%", wordBreak: "break-all" }}
      />
      <p>
        <button
          className="button"
          type="button"
          data-testid="submit-claim"
          disabled={busy || txSig.trim().length === 0}
          onClick={() => void onSubmit()}
        >
          Sign &amp; submit claim
        </button>
      </p>

      {state && (
        <div data-testid="claim-status" data-phase={state.phase}>
          {state.phase === "signing" && (
            <p className="muted">Sign the claim in your wallet…</p>
          )}
          {state.phase === "verifying" && (
            <p className="muted">Verifying payment and delivery…</p>
          )}
          {state.phase === "error" && (
            <p className="errors" data-testid="claim-flow-error">
              {state.error}
            </p>
          )}
          {state.phase === "done" && (
            <>
              <p data-testid="claim-verified">
                {state.signatureValid ? (
                  <span className="badge" data-state="verified">
                    Wallet signature verified
                  </span>
                ) : (
                  <span className="badge" data-state="mismatch">
                    Wallet signature did NOT match the paying wallet
                  </span>
                )}
              </p>
              {state.serverVerdict && (
                <p data-testid="claim-verdict" data-ok={state.serverVerdict.ok}>
                  {state.serverVerdict.ok
                    ? "Verified on-chain — your claim is ready for the DAO vote."
                    : `Not verified: ${state.serverVerdict.reasons.join("; ")}`}
                </p>
              )}
              <p className="muted">Submission (lodge this with your reimbursement proposal):</p>
              <pre
                data-testid="claim-submission"
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
              >
                {JSON.stringify(state.submission, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}
    </>
  );
}
