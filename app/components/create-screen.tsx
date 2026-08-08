"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "./wallet-provider";
import { makeSigningWallet } from "../lib/signing-wallet";
import { getConnection } from "../lib/solana";
import { createCoin } from "../lib/coin-actions";
import { apiConfigured, launchpadApi } from "../lib/launchpad-api";
import { rememberCoin } from "../lib/chain-coin";
import type { SendState } from "../lib/tx-sender";
import { explorerTx } from "../lib/cluster";

async function fileToBase64(file: File): Promise<{ base64: string; mime: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { base64: btoa(bin), mime: file.type };
}

export function CreateScreen() {
  const { wallet, account, openModal } = useWallet();
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [state, setState] = useState<SendState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function launch() {
    setError(null);
    setState(null);
    if (!wallet || !account) {
      openModal();
      return;
    }
    if (!name || !symbol) {
      setError("Name and ticker are required.");
      return;
    }
    setBusy(true);
    try {
      let uri = "https://example.invalid/meta.json";
      if (image && apiConfigured()) {
        setSteps(["Uploading image + metadata…"]);
        const { base64, mime } = await fileToBase64(image);
        const res = await launchpadApi.uploadMetadata({ name, symbol, description, imageBase64: base64, imageMime: mime });
        uri = res.uri;
      }
      setSteps((s) => [...s, "Creating the coin…"]);
      const signer = makeSigningWallet(wallet, account);
      const { state: st, mint } = await createCoin(
        { name, symbol, uri },
        { connection: getConnection(), wallet: signer, onState: setState },
      );
      if (st.phase === "confirmed") {
        rememberCoin(mint.toBase58());
        router.push(`/coin?mint=${mint.toBase58()}`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560, margin: "1.5rem auto" }}>
      <h1>Launch a coin</h1>
      <p className="muted small">
        A fair bonding curve: the whole supply starts on the curve, mint and
        freeze authorities are revoked, and it graduates to Raydium with the LP
        burned. No presale, no team allocation.
      </p>
      <form className="launch" onSubmit={(e) => { e.preventDefault(); void launch(); }}>
        <label className="field"><span>Name</span>
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-testid="coin-name" />
        </label>
        <label className="field"><span>Ticker</span>
          <input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} data-testid="coin-symbol" />
        </label>
        <label className="field"><span>Description</span>
          <textarea value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="field"><span>Image</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
        </label>
        {!apiConfigured() && <p className="muted small">Image upload needs the backend API; the coin still launches without one.</p>}
        <button className="button primary" type="submit" disabled={busy} data-testid="launch-submit">
          {busy ? "Launching…" : wallet ? "Launch" : "Connect wallet"}
        </button>
      </form>
      <ul className="steps">
        {steps.map((s, i) => (<li key={i}>{s}</li>))}
      </ul>
      {state && state.phase !== "confirmed" && (
        <p className="status" data-phase={state.phase === "failed" ? "error" : state.phase}>
          {state.phase === "failed" ? `❌ ${state.message ?? state.reason}` : `⏳ ${state.phase}…`}
        </p>
      )}
      {state?.phase === "confirmed" && state.signature && (
        <p className="status" data-phase="done">✅ Launched — <a href={explorerTx(state.signature)} target="_blank" rel="noreferrer">view</a></p>
      )}
      {error && <div className="errors">{error}</div>}
    </div>
  );
}
