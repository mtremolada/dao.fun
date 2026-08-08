"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  apiConfigured,
  launchpadApi,
  subscribeLaunchpad,
  type CoinView,
} from "../lib/launchpad-api";
import { truncateAddress } from "../lib/wallet-registry";

type Tab = "new" | "graduating" | "graduated";
const TABS: { key: Tab; label: string }[] = [
  { key: "new", label: "New" },
  { key: "graduating", label: "About to graduate" },
  { key: "graduated", label: "Graduated" },
];

function CoinCard({ coin }: { coin: CoinView }) {
  const pct = Math.round(coin.progressBps / 100);
  const state = coin.migrated ? "verified" : coin.complete ? "amber" : "missing";
  return (
    <Link href={`/coin?mint=${coin.mint}`} className="card coin-card" data-testid={`coin-${coin.symbol}`}>
      <div className="coin-card-head">
        <strong>{coin.name}</strong>
        <span className="ticker">${coin.symbol}</span>
        <span className="badge" data-state={state}>
          {coin.migrated ? "Graduated" : coin.complete ? "Migrating" : `${pct}%`}
        </span>
      </div>
      <div className="progress" aria-label="graduation progress">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="muted small">by {truncateAddress(coin.creator)}</div>
    </Link>
  );
}

export function BoardScreen() {
  const [tab, setTab] = useState<Tab>("new");
  const [coins, setCoins] = useState<CoinView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    launchpadApi
      .board(tab)
      .then((c) => live && (setCoins(c), setError(null)))
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [tab]);

  // Live updates: refresh the current tab when the feed reports activity.
  useEffect(() => {
    return subscribeLaunchpad(() => {
      launchpadApi.board(tab).then(setCoins).catch(() => {});
    });
  }, [tab]);

  return (
    <div className="board">
      <div className="board-head">
        <h1>Launchpad</h1>
        <Link href="/create" className="button">
          Launch a coin
        </Link>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
            data-testid={`tab-${t.key}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!apiConfigured() && (
        <div className="card muted">
          The live board needs the backend API. Set <code>NEXT_PUBLIC_API_URL</code> to see coins.
        </div>
      )}
      {error && <div className="errors">Could not load the board: {error}</div>}
      {loading ? (
        <div className="card muted">Loading…</div>
      ) : coins.length === 0 ? (
        <div className="card empty">
          <p>No coins here yet.</p>
          <Link href="/create" className="button">
            Be the first to launch one
          </Link>
        </div>
      ) : (
        <div className="mode-grid">
          {coins.map((c) => (
            <CoinCard key={c.mint} coin={c} />
          ))}
        </div>
      )}
    </div>
  );
}
