"use client";

/**
 * Wallet voting actions (D-028): connect a wallet-standard wallet, then
 * vote on the proposal through the browser-signing seam — the backend
 * builds the unsigned tx, the wallet signs raw bytes, the backend
 * submits. No chain deps in the bundle.
 */
import { useState } from "react";
import {
  castVoteFlow,
  type FlowState,
  type SignerLike,
} from "../lib/governance-actions";
import {
  connectWallet,
  discoverWallets,
  makeSigner,
} from "../lib/wallet-standard";

const PHASE_COPY: Record<FlowState["phase"], string> = {
  building: "Building transaction…",
  signing: "Waiting for the wallet signature…",
  submitting: "Submitting…",
  done: "Vote submitted",
  error: "Vote failed",
};

export function WalletActions(props: { proposal: string }) {
  const [signer, setSigner] = useState<SignerLike | null>(null);
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect() {
    try {
      const wallets = discoverWallets();
      if (wallets.length === 0) {
        setConnectError("No wallet found — install a Solana wallet extension.");
        return;
      }
      const wallet = wallets[0]!;
      const account = await connectWallet(wallet);
      setSigner(makeSigner(wallet, account));
      setConnectError(null);
    } catch (e) {
      setConnectError((e as Error).message);
    }
  }

  async function vote(approve: boolean) {
    if (!signer) return;
    await castVoteFlow(
      { proposal: props.proposal, approve },
      { signer, onState: setFlow },
    );
  }

  const busy =
    flow !== null && flow.phase !== "done" && flow.phase !== "error";

  return (
    <>
      <h2>Vote</h2>
      {!signer ? (
        <>
          <button
            className="button"
            type="button"
            data-testid="connect-wallet"
            onClick={() => void connect()}
          >
            Connect wallet
          </button>
          {connectError && (
            <p className="errors" data-testid="connect-error">
              {connectError}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted" data-testid="wallet-address">
            Connected: {signer.address}
          </p>
          <button
            className="button"
            type="button"
            data-testid="vote-approve"
            disabled={busy}
            onClick={() => void vote(true)}
          >
            Vote yes
          </button>{" "}
          <button
            className="button"
            type="button"
            data-testid="vote-deny"
            disabled={busy}
            onClick={() => void vote(false)}
          >
            Vote no
          </button>
        </>
      )}
      {flow && (
        <p data-testid="vote-status" data-phase={flow.phase}>
          {PHASE_COPY[flow.phase]}
          {flow.signature && (
            <span className="muted" data-testid="vote-signature">
              {" "}
              {flow.signature}
            </span>
          )}
          {flow.error && <span className="errors"> {flow.error}</span>}
        </p>
      )}
    </>
  );
}
