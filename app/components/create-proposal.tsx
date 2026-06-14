"use client";

/**
 * Create a governance proposal from the DAO page — client-only. MVP action:
 * grant (a SOL transfer from the treasury vault to a recipient, spec 6.8),
 * built through the real-binary-tested SDK and submitted create -> insert ->
 * sign-off by the connected wallet. The proposer must already hold deposited
 * governing tokens (>= the proposal threshold) — deposit above first.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { getConnection } from "../lib/solana";
import {
  runCreateGrantProposal,
  type ProposeStep,
} from "../lib/propose";
import { useWallet } from "./wallet-provider";

function isPubkey(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

export function CreateProposal({
  mint,
  vault,
  multisig,
}: {
  mint: string;
  vault: string;
  multisig: string;
}) {
  const { sender, openModal } = useWallet();

  const [recipient, setRecipient] = useState("");
  const [amountSol, setAmountSol] = useState("");
  const [name, setName] = useState("");
  const [steps, setSteps] = useState<ProposeStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const amountValid = useMemo(() => Number(amountSol) > 0, [amountSol]);
  const ready =
    isPubkey(recipient) && amountValid && name.trim().length > 0 && !busy;

  async function submit() {
    setError(null);
    setProposal(null);
    if (!ready) return;
    if (!sender) {
      openModal();
      return;
    }
    setBusy(true);
    setSteps([]);
    try {
      const res = await runCreateGrantProposal(
        getConnection(),
        sender,
        {
          mint,
          vault,
          multisig,
          recipient: recipient.trim(),
          lamports: BigInt(Math.floor(Number(amountSol) * 1e9)),
          name: name.trim(),
        },
        (s) => setSteps((prev) => [...prev.filter((p) => p.step !== s.step), s]),
      );
      setProposal(res.proposal);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (proposal) {
    return (
      <div className="summary-card" data-testid="propose-result">
        <span className="badge" data-state="verified">
          ✓ Proposal created — voting is open
        </span>
        <p className="muted" style={{ wordBreak: "break-all" }}>
          Proposal: {proposal}
        </p>
        <Link className="button" href={`/proposal?id=${proposal}`}>
          Open proposal to vote →
        </Link>
      </div>
    );
  }

  return (
    <form
      className="launch"
      data-testid="create-proposal"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>Create a proposal</h2>
      <p className="muted">
        Propose a <b>grant</b> — a SOL payout from the treasury vault. It passes
        through a community vote and the hold-up before anyone can execute it.
        You must hold deposited governing tokens (deposit above) to propose.
      </p>

      <label htmlFor="prop-recipient">Recipient wallet</label>
      <input
        id="prop-recipient"
        data-testid="prop-recipient"
        type="text"
        value={recipient}
        onChange={(e) => setRecipient(e.target.value)}
      />
      {recipient.trim() !== "" && !isPubkey(recipient) && (
        <p className="errors">That doesn&apos;t look like a Solana address.</p>
      )}

      <label htmlFor="prop-amount">Amount (SOL)</label>
      <input
        id="prop-amount"
        data-testid="prop-amount"
        type="number"
        min={0}
        step="0.01"
        value={amountSol}
        onChange={(e) => setAmountSol(e.target.value)}
      />

      <label htmlFor="prop-name">Proposal title</label>
      <input
        id="prop-name"
        data-testid="prop-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {steps.length > 0 && (
        <ul className="result" data-testid="propose-progress">
          {steps.map((s) => (
            <li key={s.step}>
              {s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏳"}{" "}
              {s.step}
              {s.error ? ` — ${s.error}` : ""}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="errors" data-testid="propose-error">
          {error}
        </p>
      )}

      <button
        className="button"
        type="submit"
        data-testid="propose-submit"
        disabled={!ready}
      >
        {busy
          ? "Submitting…"
          : sender
            ? "Create grant proposal"
            : "Connect wallet to propose"}
      </button>
    </form>
  );
}
