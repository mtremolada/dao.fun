"use client";

/**
 * Proposal voting — fully client-side. Uses the app-wide connected wallet
 * (top-right connect step): the vote tx is built in the browser over the
 * user's RPC and the wallet signs + broadcasts it through its own RPC. No
 * server. When no wallet is connected, the panel opens the connect modal.
 */
import { useState } from "react";
import { castVoteFlow, type FlowState } from "../lib/governance-actions";
import { getConnection } from "../lib/solana";
import { useWallet } from "./wallet-provider";

const PHASE_COPY: Record<FlowState["phase"], string> = {
  building: "Building transaction…",
  sending: "Confirm in your wallet…",
  done: "Vote submitted",
  error: "Vote failed",
};

export function WalletActions(props: { proposal: string }) {
  const { sender, account, openModal } = useWallet();
  const [flow, setFlow] = useState<FlowState | null>(null);

  async function vote(approve: boolean) {
    if (!sender) return;
    await castVoteFlow(
      { proposal: props.proposal, approve },
      { connection: getConnection(), sender, onState: setFlow },
    );
  }

  const busy = flow !== null && flow.phase !== "done" && flow.phase !== "error";

  return (
    <>
      <h2>Vote</h2>
      {!sender ? (
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
