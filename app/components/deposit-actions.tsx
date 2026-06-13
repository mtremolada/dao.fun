"use client";

/**
 * Deposit governing tokens (D-033) — the client half of vote-weight: connect
 * a wallet-standard wallet, then deposit community tokens into the realm to
 * gain vote weight. The SDK builds the unsigned tx against the user's RPC,
 * the wallet signs, the SDK submits — no server in the path.
 */
import { useState } from "react";
import {
  depositFlow,
  type FlowState,
  type SignerLike,
} from "../lib/governance-actions";
import { PublicKey } from "@solana/web3.js";
import {
  connectWallet,
  discoverWallets,
  makeSigner,
} from "../lib/wallet-standard";
import { getConnection, getTxSource } from "../lib/rpc";

const PHASE_COPY: Record<FlowState["phase"], string> = {
  building: "Building transaction…",
  signing: "Waiting for the wallet signature…",
  submitting: "Submitting…",
  done: "Deposit submitted",
  error: "Deposit failed",
};

export function DepositActions(props: {
  realm: string;
  governingTokenMint: string;
}) {
  const [signer, setSigner] = useState<SignerLike | null>(null);
  const [amount, setAmount] = useState("");
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  async function connect() {
    try {
      const wallets = discoverWallets();
      if (wallets.length === 0) {
        setConnectError("No wallet found — install a Solana wallet extension.");
        return;
      }
      const account = await connectWallet(wallets[0]!);
      setSigner(makeSigner(wallets[0]!, account));
      setConnectError(null);
    } catch (e) {
      setConnectError((e as Error).message);
    }
  }

  async function deposit() {
    if (!signer || amount.trim() === "") return;
    // The source ATA lives under the mint's owner program (classic Token or
    // Token-2022); detect it so the deposit targets the right account.
    let tokenProgram: string | undefined;
    try {
      const info = await getConnection().getAccountInfo(
        new PublicKey(props.governingTokenMint),
      );
      if (info) tokenProgram = info.owner.toBase58();
    } catch {
      // fall back to the builder default (classic Token program)
    }
    await depositFlow(
      {
        realm: props.realm,
        governingTokenMint: props.governingTokenMint,
        amount: amount.trim(),
        ...(tokenProgram ? { tokenProgram } : {}),
      },
      { signer, source: getTxSource(), onState: setFlow },
    );
  }

  const busy = flow !== null && flow.phase !== "done" && flow.phase !== "error";

  return (
    <>
      <h2>Deposit for vote weight</h2>
      {!signer ? (
        <>
          <button
            className="button"
            type="button"
            data-testid="connect-wallet-deposit"
            onClick={() => void connect()}
          >
            Connect wallet
          </button>
          {connectError && (
            <p className="errors" data-testid="connect-error-deposit">
              {connectError}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted" data-testid="wallet-address-deposit">
            Connected: {signer.address}
          </p>
          <label htmlFor="deposit-amount">
            Amount (raw token units, before decimals)
          </label>{" "}
          <input
            id="deposit-amount"
            data-testid="deposit-amount"
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />{" "}
          <button
            className="button"
            type="button"
            data-testid="deposit-submit"
            disabled={busy || amount.trim() === ""}
            onClick={() => void deposit()}
          >
            Deposit
          </button>
        </>
      )}
      {flow && (
        <p data-testid="deposit-status" data-phase={flow.phase}>
          {PHASE_COPY[flow.phase]}
          {flow.signature && (
            <span className="muted" data-testid="deposit-signature">
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
