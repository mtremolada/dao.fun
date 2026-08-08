"use client";

/**
 * The coin page IS the trading terminal: live chart (candles + volume),
 * stats strip, activity tabs (trades / top traders / info), position card,
 * and the buy/sell panel — all working with ONLY an RPC. The chain-direct
 * trade indexer (chain-trades.ts) feeds history when no backend is
 * configured; the hosted indexer + SSE take over when it is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { spotPriceSol } from "@daofun/sdk/launchpad";
import {
  apiConfigured,
  launchpadApi,
  subscribeLaunchpad,
  type Candle,
  type CoinView,
  type TradeView,
} from "../lib/launchpad-api";
import { fetchCoinFromChain, rememberCoin } from "../lib/chain-coin";
import { candlesFromTrades, watchTrades } from "../lib/chain-trades";
import {
  ammBuy,
  ammSell,
  ammSpotPriceSol,
  fetchAmmContext,
  quoteAmmBuy,
  quoteAmmSell,
  type AmmContext,
} from "../lib/amm-actions";
import { computePosition, topTraders } from "../lib/position";
import { useWallet } from "./wallet-provider";
import { makeSigningWallet } from "../lib/signing-wallet";
import { getConnection } from "../lib/solana";
import { buy, quoteBuy, quoteSell, sell } from "../lib/coin-actions";
import type { SendState } from "../lib/tx-sender";
import { explorerAddress, explorerTx, ENABLE_DEVNET_HINTS } from "../lib/cluster";
import { truncateAddress } from "../lib/wallet-registry";
import { PriceChart, type ChartMode } from "./price-chart";

const SOL = (lamports: string | bigint | number) =>
  (Number(typeof lamports === "number" ? lamports : BigInt(lamports)) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });
const TOKENS = (base: string | bigint) =>
  (Number(BigInt(base)) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });
const PRICE = (solPerToken: number) =>
  solPerToken >= 0.001 ? solPerToken.toFixed(6) : solPerToken.toExponential(3);

const RESOLUTIONS: { label: string; seconds: number }[] = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
];

/* ---------------------------------------------------------------- stats -- */

function StatsStrip({
  coin,
  candles,
  ammSpot,
}: {
  coin: CoinView;
  candles: Candle[];
  ammSpot: number | null;
}) {
  const spot = ammSpot ?? spotPriceSol(BigInt(coin.virtualSol), BigInt(coin.virtualToken));
  const last = candles[candles.length - 1];
  const dayAgo = (last?.time ?? 0) - 86_400;
  const ref = candles.filter((c) => c.time <= dayAgo).at(-1) ?? candles[0];
  const change =
    last && ref && ref !== last && ref.close > 0 ? (last.close / ref.close - 1) * 100 : null;
  const vol24 = candles.filter((c) => c.time > dayAgo).reduce((s, c) => s + c.volume, 0);
  return (
    <div className="stats-strip card" data-testid="stats-strip">
      <div className="stat">
        <span className="muted small">Price</span>
        <strong data-testid="stat-price">{PRICE(spot)} SOL</strong>
      </div>
      <div className="stat">
        <span className="muted small">Market cap</span>
        <strong data-testid="stat-mcap">{(spot * 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL</strong>
      </div>
      <div className="stat">
        <span className="muted small">24h</span>
        <strong className={change === null ? "" : change >= 0 ? "up" : "down"} data-testid="stat-change">
          {change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
        </strong>
      </div>
      <div className="stat">
        <span className="muted small">24h volume</span>
        <strong>{vol24.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL</strong>
      </div>
      <div className="stat">
        <span className="muted small">Raised</span>
        <strong>{SOL(coin.realSol)} SOL</strong>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- chart -- */

function ChartCard({ candles }: { candles: Candle[] }) {
  const [res, setRes] = useState(300);
  const [mode, setMode] = useState<ChartMode>("mcap");
  const bucketed = useMemo(() => rebucket(candles, res), [candles, res]);
  return (
    <div className="card">
      <div className="chart-controls">
        <div className="tabs">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.seconds}
              className={`tab ${res === r.seconds ? "active" : ""}`}
              onClick={() => setRes(r.seconds)}
              data-testid={`res-${r.label}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="tabs">
          {(["mcap", "price"] as const).map((m) => (
            <button
              key={m}
              className={`tab ${mode === m ? "active" : ""}`}
              onClick={() => setMode(m)}
              data-testid={`mode-${m}`}
            >
              {m === "mcap" ? "MCap" : "Price"}
            </button>
          ))}
        </div>
      </div>
      <PriceChart candles={bucketed} mode={mode} />
    </div>
  );
}

/** Candles arrive at 60s base resolution; coarser views re-bucket locally. */
function rebucket(candles: Candle[], res: number): Candle[] {
  if (res === 60) return candles;
  const out = new Map<number, Candle>();
  for (const c of candles) {
    const t = Math.floor(c.time / res) * res;
    const b = out.get(t);
    if (!b) out.set(t, { ...c, time: t });
    else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------- position -- */

function PositionCard({
  coin,
  trades,
  walletTokens,
  address,
  ammSpot,
}: {
  coin: CoinView;
  trades: TradeView[];
  walletTokens: bigint | null;
  address: string;
  ammSpot: number | null;
}) {
  const spot = ammSpot ?? spotPriceSol(BigInt(coin.virtualSol), BigInt(coin.virtualToken));
  const pos = useMemo(() => computePosition(trades, address, spot), [trades, address, spot]);
  const held = walletTokens ?? pos.tokens;
  if (held === 0n && pos.realizedLamports === 0) return null;
  const pnlClass = (v: number) => (v >= 0 ? "up" : "down");
  return (
    <div className="card position-card" data-testid="position-card">
      <h2>Your position</h2>
      <dl className="kv">
        <div className="kv-row"><dt>Balance</dt><dd>{TOKENS(held)} {coin.symbol}</dd></div>
        <div className="kv-row"><dt>Value</dt><dd>{SOL(Math.round((Number(held) / 1e6) * spot * 1e9))} SOL</dd></div>
        <div className="kv-row"><dt>Avg cost</dt><dd>{PRICE(pos.avgCostSolPerToken)} SOL</dd></div>
        <div className="kv-row">
          <dt>Unrealized</dt>
          <dd className={pnlClass(pos.unrealizedLamports)} data-testid="pnl-unrealized">
            {pos.unrealizedLamports >= 0 ? "+" : "−"}{SOL(Math.abs(Math.round(pos.unrealizedLamports)))} SOL
          </dd>
        </div>
        <div className="kv-row">
          <dt>Realized</dt>
          <dd className={pnlClass(pos.realizedLamports)}>
            {pos.realizedLamports >= 0 ? "+" : "−"}{SOL(Math.abs(Math.round(pos.realizedLamports)))} SOL
          </dd>
        </div>
      </dl>
      <p className="muted small">PnL from your trades on this curve.</p>
    </div>
  );
}

/* ---------------------------------------------------------- trade panel -- */

function TradePanel({
  coin,
  amm,
  solBalance,
  tokenBalance,
  onConfirmed,
}: {
  coin: CoinView;
  amm: AmmContext | null | undefined;
  solBalance: number | null;
  tokenBalance: bigint | null;
  onConfirmed: () => void;
}) {
  const { wallet, account } = useWallet();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippage] = useState(100);
  const [state, setState] = useState<SendState | null>(null);
  const onAmm = coin.migrated && amm != null;

  const quote = useMemo(() => {
    try {
      if (!amount || Number(amount) <= 0) return null;
      if (side === "buy") {
        const budget = BigInt(Math.floor(Number(amount) * 1e9));
        if (onAmm) {
          const tokensOut = quoteAmmBuy(amm, budget);
          if (tokensOut <= 0n) return null;
          return { out: `${TOKENS(tokensOut)} ${coin.symbol}`, tokensOut, cost: budget };
        }
        const q = quoteBuy(coin, budget);
        return { out: `${TOKENS(q.tokensOut)} ${coin.symbol}`, tokensOut: q.tokensOut, cost: q.cost };
      }
      const tokens = BigInt(Math.floor(Number(amount) * 1e6));
      const net = onAmm ? quoteAmmSell(amm, tokens) : quoteSell(coin, tokens);
      return { out: `${SOL(net)} SOL`, tokenAmount: tokens, net };
    } catch {
      return null;
    }
  }, [amount, side, coin, amm, onAmm]);

  async function submit() {
    if (!wallet || !account) return;
    const signer = makeSigningWallet(wallet, account);
    const ctx = {
      connection: getConnection(),
      wallet: signer,
      onState: (s: SendState) => {
        setState(s);
        if (s.phase === "confirmed") onConfirmed();
      },
    };
    try {
      if (side === "buy" && quote?.tokensOut && quote.cost !== undefined) {
        if (onAmm) {
          await ammBuy(
            coin,
            { lamportsIn: quote.cost, minTokensOut: quote.tokensOut, slippageBps },
            ctx,
            amm,
          );
        } else {
          await buy(coin, { tokensOut: quote.tokensOut, maxSolCost: quote.cost, slippageBps }, ctx);
        }
      } else if (side === "sell" && quote?.tokenAmount && quote.net !== undefined) {
        if (onAmm) {
          await ammSell(
            coin,
            { tokensIn: quote.tokenAmount, minLamportsOut: quote.net, slippageBps },
            ctx,
            amm,
          );
        } else {
          await sell(coin, { tokenAmount: quote.tokenAmount, minSolOutput: quote.net, slippageBps }, ctx);
        }
      }
    } catch (e) {
      setState({ phase: "failed", reason: "rpc-error", message: (e as Error).message });
    }
  }

  const busy = state !== null && !["confirmed", "failed"].includes(state.phase);
  const disabled = (coin.complete || coin.migrated) && !onAmm;

  const buyPresets = [0.1, 0.5, 1];
  const maxBuy = solBalance !== null ? Math.max(0, (solBalance - 20_000_000) / 1e9) : null;
  const sellPct = [25, 50, 100];
  const heldTokens = tokenBalance ?? 0n;

  return (
    <div className="card trade-panel">
      <div className="tabs">
        <button className={`tab ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")} data-testid="side-buy">Buy</button>
        <button className={`tab ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")} data-testid="side-sell">Sell</button>
      </div>
      {disabled ? (
        <p className="muted">
          {!coin.migrated
            ? "Curve complete — graduation to Raydium is pending."
            : amm === undefined
              ? "Loading the Raydium pool…"
              : "Trading closed here — this curve has graduated to Raydium."}
        </p>
      ) : (
        <>
          {onAmm && (
            <p className="muted small" data-testid="amm-note">
              Graduated — trading on the Raydium pool ({Number(amm.tradeFeeRate) / 10_000}% fee).
            </p>
          )}
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
          <div className="presets">
            {side === "buy" ? (
              <>
                {buyPresets.map((v) => (
                  <button key={v} className="preset" onClick={() => setAmount(String(v))} data-testid={`preset-${v}`}>
                    {v} SOL
                  </button>
                ))}
                {maxBuy !== null && maxBuy > 0 && (
                  <button className="preset" onClick={() => setAmount(maxBuy.toFixed(4))} data-testid="preset-max">
                    MAX
                  </button>
                )}
              </>
            ) : (
              sellPct.map((p) => (
                <button
                  key={p}
                  className="preset"
                  disabled={heldTokens === 0n}
                  onClick={() => setAmount((Number((heldTokens * BigInt(p)) / 100n) / 1e6).toFixed(4))}
                  data-testid={`preset-${p}pct`}
                >
                  {p}%
                </button>
              ))
            )}
          </div>
          {solBalance !== null && (
            <p className="muted small">
              Balance: {SOL(solBalance)} SOL{tokenBalance !== null && <> · {TOKENS(tokenBalance)} {coin.symbol}</>}
            </p>
          )}
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

/* ------------------------------------------------------------- activity -- */

type ActivityTab = "trades" | "traders" | "info";

function ActivityTabs({ coin, trades, myAddress }: { coin: CoinView; trades: TradeView[]; myAddress: string | null }) {
  const [tab, setTab] = useState<ActivityTab>("trades");
  return (
    <div className="card">
      <div className="tabs">
        {([["trades", "Trades"], ["traders", "Top traders"], ["info", "Info"]] as const).map(([k, label]) => (
          <button key={k} className={`tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)} data-testid={`activity-${k}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "trades" && <TradesFeed coin={coin} trades={trades} />}
      {tab === "traders" && <TradersTable coin={coin} trades={trades} myAddress={myAddress} />}
      {tab === "info" && <InfoPanel coin={coin} />}
    </div>
  );
}

function TradesFeed({ coin, trades }: { coin: CoinView; trades: TradeView[] }) {
  if (trades.length === 0) return <p className="muted">No trades yet.</p>;
  return (
    <div className="table-scroll">
      <table data-testid="trades-feed">
        <thead><tr><th>Side</th><th>{coin.symbol}</th><th>SOL</th><th>Price</th><th>Trader</th><th>Time</th><th></th></tr></thead>
        <tbody>
          {trades.slice(0, 50).map((t, i) => (
            <tr key={`${t.signature}:${i}`} className={t.isBuy ? "buy" : "sell"}>
              <td>{t.isBuy ? "Buy" : "Sell"}</td>
              <td>{TOKENS(t.tokenAmount)}</td>
              <td>{SOL(t.solAmount)}</td>
              <td>{PRICE(spotPriceSol(BigInt(t.virtualSol), BigInt(t.virtualToken)))}</td>
              <td>{truncateAddress(t.trader)}</td>
              <td>{t.blockTime ? new Date(t.blockTime * 1000).toLocaleTimeString() : "—"}</td>
              <td><a href={explorerTx(t.signature)} target="_blank" rel="noreferrer">↗</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradersTable({ coin, trades, myAddress }: { coin: CoinView; trades: TradeView[]; myAddress: string | null }) {
  const stats = useMemo(() => topTraders(trades), [trades]);
  if (stats.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <div className="table-scroll">
      <table data-testid="traders-table">
        <thead><tr><th>#</th><th>Trader</th><th>Net {coin.symbol}</th><th>Bought</th><th>Sold</th><th>Trades</th></tr></thead>
        <tbody>
          {stats.map((s, i) => (
            <tr key={s.trader}>
              <td>{i + 1}</td>
              <td>
                {truncateAddress(s.trader)}
                {s.trader === coin.creator && <span className="badge" data-state="amber"> creator</span>}
                {s.trader === myAddress && <span className="badge" data-state="verified"> you</span>}
              </td>
              <td>{TOKENS(s.netTokens < 0n ? 0n : s.netTokens)}</td>
              <td>{SOL(Math.round(s.boughtSol))}</td>
              <td>{SOL(Math.round(s.soldSol))}</td>
              <td>{s.trades}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Derived from curve trades{coin.migrated ? " — post-graduation AMM activity not included" : ""}.</p>
    </div>
  );
}

function InfoPanel({ coin }: { coin: CoinView }) {
  const row = (label: string, addr: string) => (
    <div className="kv-row" key={label}>
      <dt>{label}</dt>
      <dd><a href={explorerAddress(addr)} target="_blank" rel="noreferrer">{truncateAddress(addr, 8, 8)}</a></dd>
    </div>
  );
  return (
    <dl className="kv" data-testid="info-panel">
      {row("Mint", coin.mint)}
      {row("Creator", coin.creator)}
      {coin.poolState && row("Raydium pool", coin.poolState)}
      <div className="kv-row">
        <dt>Supply</dt>
        <dd>1,000,000,000 {coin.symbol} — mint & freeze revoked</dd>
      </div>
      <div className="kv-row">
        <dt>Graduation</dt>
        <dd>{coin.migrated ? "Graduated — LP burned" : "Migrates to Raydium at completion; LP burned"}</dd>
      </div>
      {coin.uri && (
        <div className="kv-row">
          <dt>Metadata</dt>
          <dd><a href={coin.uri} target="_blank" rel="noreferrer">{coin.uri.slice(0, 40)}…</a></dd>
        </div>
      )}
    </dl>
  );
}

/* ----------------------------------------------------------------- page -- */

export function CoinScreen() {
  const params = useSearchParams();
  const mint = params.get("mint");
  const { account } = useWallet();
  const [coin, setCoin] = useState<CoinView | null>(null);
  // undefined = not loaded yet; null = pool unavailable; object = tradable.
  const [amm, setAmm] = useState<AmmContext | null | undefined>(undefined);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [apiCandles, setApiCandles] = useState<Candle[] | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [walletTokens, setWalletTokens] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Coin state: chain first (works with only an RPC), indexer as enhancement.
  useEffect(() => {
    if (!mint) return;
    let live = true;
    rememberCoin(mint);
    fetchCoinFromChain(getConnection(), mint)
      .then((c) => {
        if (!live) return;
        if (c) {
          setCoin(c);
          setError(null);
        } else if (!apiConfigured()) {
          setError("No curve found for this mint on this cluster.");
        }
      })
      .catch(() => {});
    if (apiConfigured()) {
      launchpadApi.coin(mint).then((c) => live && setCoin(c)).catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [mint, tick]);

  // Trade history: hosted indexer + SSE when configured, chain poller otherwise.
  useEffect(() => {
    if (!mint) return;
    let live = true;
    if (apiConfigured()) {
      const load = () => {
        launchpadApi.trades(mint).then((t) => live && setTrades(t)).catch(() => {});
        launchpadApi.candles(mint, 60).then((c) => live && setApiCandles(c)).catch(() => {});
      };
      load();
      const unsub = subscribeLaunchpad((_k, data) => {
        const d = data as { event?: { mint?: string } };
        if (d.event?.mint === mint) {
          load();
          refresh();
        }
      });
      return () => {
        live = false;
        unsub();
      };
    }
    const unwatch = watchTrades(getConnection(), mint, (t) => live && setTrades(t));
    return () => {
      live = false;
      unwatch();
    };
  }, [mint, refresh]);

  // Wallet balances for presets/position — refreshed after every confirm.
  useEffect(() => {
    if (!mint || !account) {
      setSolBalance(null);
      setWalletTokens(null);
      return;
    }
    let live = true;
    const connection = getConnection();
    const owner = new PublicKey(account.address);
    connection.getBalance(owner).then((b) => live && setSolBalance(b)).catch(() => {});
    connection
      .getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), owner, true))
      .then((r) => live && setWalletTokens(BigInt(r.value.amount)))
      .catch(() => live && setWalletTokens(null));
    return () => {
      live = false;
    };
  }, [mint, account, tick]);

  // The Raydium pool context, once graduated — quotes, spot price, and the
  // swap accounts all come from this one fetch.
  useEffect(() => {
    if (!coin?.migrated) {
      setAmm(undefined);
      return;
    }
    let live = true;
    fetchAmmContext(getConnection(), coin)
      .then((a) => live && setAmm(a))
      .catch(() => live && setAmm(null));
    return () => {
      live = false;
    };
  }, [coin, tick]);

  const candles = useMemo(
    () => apiCandles ?? candlesFromTrades(trades, 60),
    [apiCandles, trades],
  );
  const ammSpot = amm ? ammSpotPriceSol(amm) : null;

  if (!mint) return <div className="errors">No coin specified.</div>;
  if (error) return <div className="errors">Could not load this coin: {error}</div>;
  if (!coin) return <div className="card muted">Loading…</div>;

  const pct = Math.round(coin.progressBps / 100);
  return (
    <div className="terminal">
      <div className="terminal-main">
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

        <StatsStrip coin={coin} candles={candles} ammSpot={ammSpot} />
        <ChartCard candles={candles} />
        <ActivityTabs coin={coin} trades={trades} myAddress={account?.address ?? null} />
      </div>

      <aside className="coin-side">
        <TradePanel
          coin={coin}
          amm={amm}
          solBalance={solBalance}
          tokenBalance={walletTokens}
          onConfirmed={refresh}
        />
        {account && (
          <PositionCard
            coin={coin}
            trades={trades}
            walletTokens={walletTokens}
            address={account.address}
            ammSpot={ammSpot}
          />
        )}
      </aside>
    </div>
  );
}
