"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  launchpadApi,
  subscribeLaunchpad,
  type CoinView,
  type TradeView,
} from "../lib/launchpad-api";
import { useWallet } from "./wallet-provider";
import { makeSigningWallet } from "../lib/signing-wallet";
import { getConnection } from "../lib/solana";
import { buy, quoteBuy, quoteSell, sell } from "../lib/coin-actions";
import type { SendState } from "../lib/tx-sender";
import { explorerAddress, explorerTx, ENABLE_DEVNET_HINTS } from "../lib/cluster";
import { truncateAddress } from "../lib/wallet-registry";

const SOL = (lamports: string | bigint) => (Number(BigInt(lamports)) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
const TOKENS = (base: string | bigint) => (Number(BigInt(base)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

function TradePanel({ coin }: { coin: CoinView }) {
  const { wallet, account } = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippage] = useState(100);
  const [state, setState] = useState<SendState | null>(null);

  const quote = useMemo(() => {
    try {
      if (!amount || Number(amount) <= 0) return null;
      if (side === "buy") {
        const budget = BigInt(Math.floor(Number(amount) * 1e9));
        const q = quoteBuy(coin, budget);
        return { out: `${TOKENS(q.tokensOut)} ${coin.symbol}`, tokensOut: q.tokensOut, cost: q.cost };
      }
      const tokens = BigInt(Math.floor(Number(amount) * 1e6));
      return { out: `${SOL(quoteSell(coin, tokens))} SOL`, tokenAmount: tokens };
    } catch {
      return null;
    }
  }, [amount, side, coin]);

  async function submit() {
    if (!wallet || !account) return;
    const signer = makeSigningWallet(wallet, account);
    const ctx = { connection: getConnection(), wallet: signer, onState: setState };
    try {
      if (side === "buy" && quote?.tokensOut) {
        await buy(coin, { tokensOut: quote.tokensOut, maxSolCost: quote.cost!, slippageBps }, ctx);
      } else if (side === "sell" && quote?.tokenAmount) {
        const net = quoteSell(coin, quote.tokenAmount);
        await sell(coin, { tokenAmount: quote.tokenAmount, minSolOutput: net, slippageBps }, ctx);
      }
    } catch (e) {
      setState({ phase: "failed", reason: "rpc-error", message: (e as Error).message });
    }
  }

  const busy = state !== null && !["confirmed", "failed"].includes(state.phase);
  const disabled = coin.complete || coin.migrated;

  return (
    <div className="card trade-panel">
      <div className="tabs">
        <button className={`tab ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")} data-testid="side-buy">Buy</button>
        <button className={`tab ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")} data-testid="side-sell">Sell</button>
      </div>
      {disabled ? (
        <p className="muted">Trading closed — this curve has {coin.migrated ? "graduated to Raydium" : "completed"}.</p>
      ) : (
        <>
          <label className="field">
            <span>{side === "buy" ? "Amount (SOL)" : `Amount (${coin.symbol})`}</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              data-testid="trade-amount"
            />
          </label>
          {quote && <p className="quote muted">You receive ≈ <strong>{quote.out}</strong></p>}
          <label className="field">
            <span>Slippage: {slippageBps / 100}%</span>
            <input type="range" min={10} max={1000} step={10} value={slippageBps} onChange={(e) => setSlippage(Number(e.target.value))} />
          </label>
          {!wallet ? (
            <p className="muted">Connect a wallet to trade.</p>
          ) : (
            <button className="button primary" onClick={submit} disabled={busy || !quote} data-testid="trade-submit">
              {busy ? "Working…" : side === "buy" ? "Buy" : "Sell"}
            </button>
          )}
          {state && <TxStatus state={state} />}
        </>
      )}
    </div>
  );
}

function TxStatus({ state }: { state: SendState }) {
  if (state.phase === "confirmed") {
    return (
      <p className="status" data-phase="done">
        ✅ Confirmed —{" "}
        {state.signature && (
          <a href={explorerTx(state.signature)} target="_blank" rel="noreferrer">view on explorer</a>
        )}
      </p>
    );
  }
  if (state.phase === "failed") {
    const hint =
      state.reason === "wrong-cluster" ? (
        <span className="muted small">
          {" "}Set your wallet to Devnet — {ENABLE_DEVNET_HINTS.map((h) => `${h.wallet}: ${h.steps}`).join(" · ")}
        </span>
      ) : null;
    return (
      <p className="status" data-phase="error">
        ❌ {state.message ?? state.reason}
        {hint}
      </p>
    );
  }
  return <p className="status" data-phase={state.phase}>⏳ {state.phase}…</p>;
}

export function CoinScreen() {
  const params = useSearchParams();
  const mint = params.get("mint");
  const [coin, setCoin] = useState<CoinView | null>(null);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mint) return;
    let live = true;
    const load = () => {
      launchpadApi.coin(mint).then((c) => live && setCoin(c)).catch((e) => live && setError((e as Error).message));
      launchpadApi.trades(mint).then((t) => live && setTrades(t)).catch(() => {});
    };
    load();
    const unsub = subscribeLaunchpad((_k, data) => {
      const d = data as { event?: { mint?: string } };
      if (d.event?.mint === mint) load();
    });
    return () => {
      live = false;
      unsub();
    };
  }, [mint]);

  if (!mint) return <div className="errors">No coin specified.</div>;
  if (error) return <div className="errors">Could not load this coin: {error}</div>;
  if (!coin) return <div className="card muted">Loading…</div>;

  const pct = Math.round(coin.progressBps / 100);
  return (
    <div className="coin-screen">
      <div className="coin-main">
        <div className="card">
          <div className="coin-title">
            <h1>{coin.name}</h1>
            <span className="ticker">${coin.symbol}</span>
          </div>
          <div className="badges">
            <span className="badge" data-state="verified">mint revoked</span>
            <span className="badge" data-state="verified">freeze: none</span>
            {coin.migrated && <span className="badge" data-state="verified">LP burned</span>}
          </div>
          <div className="progress big" aria-label="graduation progress">
            <span style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <p className="muted small">
            {coin.migrated ? (
              <>Graduated. {coin.poolState && (<a href={explorerAddress(coin.poolState)} target="_blank" rel="noreferrer">Raydium pool</a>)}</>
            ) : (
              <>{pct}% to graduation · raised {SOL(coin.realSol)} SOL · creator {truncateAddress(coin.creator)}</>
            )}
          </p>
        </div>

        <div className="card">
          <h2>Recent trades</h2>
          {trades.length === 0 ? (
            <p className="muted">No trades yet.</p>
          ) : (
            <table>
              <thead><tr><th>Side</th><th>{coin.symbol}</th><th>SOL</th><th>Trader</th><th></th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.signature} className={t.isBuy ? "buy" : "sell"}>
                    <td>{t.isBuy ? "Buy" : "Sell"}</td>
                    <td>{TOKENS(t.tokenAmount)}</td>
                    <td>{SOL(t.solAmount)}</td>
                    <td>{truncateAddress(t.trader)}</td>
                    <td><a href={explorerTx(t.signature)} target="_blank" rel="noreferrer">↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <aside className="coin-side">
        <TradePanel coin={coin} />
      </aside>
    </div>
  );
}
