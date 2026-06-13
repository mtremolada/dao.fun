"use client";

/**
 * Proposal voting (D-028): uses the app-wide connected wallet (top-right
 * connect step) to drive the browser-signing seam — the backend builds the
 * unsigned tx, the wallet signs raw bytes, the backend submits. No chain
 * deps in the bundle. When no wallet is connected, the vote panel opens the
 * same universal connect modal.
 */
import { useState } from "react";
import { castVoteFlow, type FlowState } from "../lib/governance-actions";
import { useWallet } from "./wallet-provider";

const PHASE_COPY: Record<FlowState["phase"], string> = {
  building: "Building transaction…",
  signing: "Waiting for the wallet signature…",
  submitting: "Submitting…",
  done: "Vote submitted",
  error: "Vote failed",
};

export function WalletActions(props: { proposal: string }) {
  const { signer, account, openModal } = useWallet();
  const [flow, setFlow] = useState<FlowState | null>(null);

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
          <p className="muted">Connect a wallet to vote on this proposal.</p>
          <button
            className="button"
            type="button"
            data-testid="connect-wallet-vote"
            onClick={openModal}
          >
            Connect wallet
          </button>
        </>
      ) : (
        <>
          <p className="muted" data-testid="wallet-address">
            Connected: {account?.address}
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
