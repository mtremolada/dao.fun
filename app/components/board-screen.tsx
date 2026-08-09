"use client";

/**
 * The board — the front page. All three lifecycle columns are on screen at
 * once (New / About to graduate / Graduated) rather than behind tabs, so the
 * whole market reads at a glance. Bucketing uses the SHARED rule
 * (@daofun/sdk/launchpad boardBucket), the same one the indexer's SQL
 * implements, so the hosted and chain-direct paths agree column for column.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { boardBucket, type BoardBucket } from "@daofun/sdk/launchpad";
import {
  apiConfigured,
  launchpadApi,
  subscribeLaunchpad,
  type CoinView,
} from "../lib/launchpad-api";
import {
  fetchAllCoinsFromChain,
  fetchCoinFromChain,
  loadLocalCoins,
} from "../lib/chain-coin";
import { getConnection } from "../lib/solana";
import { truncateAddress } from "../lib/wallet-registry";

const COLUMNS: { key: BoardBucket; label: string; blurb: string }[] = [
  { key: "new", label: "New", blurb: "Fresh on the curve" },
  { key: "graduating", label: "About to graduate", blurb: "Past 80% — or waiting on the crank" },
  { key: "graduated", label: "Graduated", blurb: "Live on Raydium, LP burned" },
];

type Buckets = Record<BoardBucket, CoinView[]>;
const emptyBuckets = (): Buckets => ({ new: [], graduating: [], graduated: [] });

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
  const [buckets, setBuckets] = useState<Buckets>(emptyBuckets());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (): Promise<Buckets> => {
    if (apiConfigured()) {
      // The indexer buckets server-side; ask for all three at once.
      const [fresh, nearly, done] = await Promise.all([
        launchpadApi.board("new"),
        launchpadApi.board("graduating"),
        launchpadApi.board("graduated"),
      ]);
      return { new: fresh, graduating: nearly, graduated: done };
    }
    // No indexer: read EVERY coin from the program itself, then bucket it
    // with the same rule the indexer applies. Discovery cannot come from
    // localStorage — that showed each visitor only their own history and hid
    // every coin created elsewhere.
    const connection = getConnection();
    const found = await fetchAllCoinsFromChain(connection);

    // localStorage is a hint, not the source: a coin created seconds ago may
    // not be in the scan's snapshot yet, and the launcher should still see it.
    const seen = new Set(found.map((c) => c.mint));
    const extra = (
      await Promise.all(
        loadLocalCoins()
          .filter((m) => !seen.has(m))
          .map((m) => fetchCoinFromChain(connection, m).catch(() => null)),
      )
    ).filter((c): c is CoinView => c !== null);

    const out = emptyBuckets();
    for (const coin of [...found, ...extra]) out[boardBucket(coin)].push(coin);
    // Busiest first within each column, so an empty new coin never sits above
    // one that is actually trading.
    for (const key of Object.keys(out) as BoardBucket[]) {
      out[key].sort((a, b) => Number(BigInt(b.realSol) - BigInt(a.realSol)));
    }
    return out;
  }, []);

  useEffect(() => {
    let live = true;
    setLoading(true);
    load()
      .then((b) => {
        if (!live) return;
        setBuckets(b);
        setError(null);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [load]);

  // Live updates: every column refreshes when the feed reports activity.
  useEffect(() => {
    return subscribeLaunchpad(() => {
      load().then(setBuckets).catch(() => {});
    });
  }, [load]);

  const total = COLUMNS.reduce((n, c) => n + buckets[c.key].length, 0);
  return (
    <div className="board">
      <div className="board-head">
        <h1>Launchpad</h1>
        <Link href="/create" className="button primary">
          Create a token
        </Link>
      </div>

      {!apiConfigured() && (
        <p className="muted small">
          Showing the coins this browser has launched or visited — set{" "}
          <code>NEXT_PUBLIC_API_URL</code> for the global live board.
        </p>
      )}
      {error && <div className="errors">Could not load the board: {error}</div>}

      <div className="board-columns">
        {COLUMNS.map((col) => (
          <section key={col.key} className="board-column" data-testid={`column-${col.key}`}>
            <header className="board-column-head">
              <h2>{col.label}</h2>
              <span className="muted small">{col.blurb}</span>
            </header>
            <div className="board-column-body">
              {loading ? (
                <p className="muted small">Loading…</p>
              ) : buckets[col.key].length === 0 ? (
                <p className="muted small">
                  {col.key === "new" && total === 0 ? (
                    <>
                      Nothing here yet.{" "}
                      <Link href="/create">Be the first to launch one</Link>.
                    </>
                  ) : (
                    "Nothing here yet."
                  )}
                </p>
              ) : (
                buckets[col.key].map((c) => <CoinCard key={c.mint} coin={c} />)
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
