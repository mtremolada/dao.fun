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
import { boardBucket, type BoardBucket, type DecodedCurve } from "@daofun/sdk/launchpad";
import {
  apiConfigured,
  launchpadApi,
  subscribeLaunchpad,
  type CoinView,
} from "../lib/launchpad-api";
import {
  coinViewFromCurve,
  fetchBoardFromChain,
  loadLocalCoins,
} from "../lib/chain-coin";
import { watchAllCurves, type LiveStatus } from "../lib/live";
import { getConnection } from "../lib/solana";
import { readPreferApi } from "../lib/read-path";
import { batchByFrame } from "../lib/coalesce";
import { truncateAddress } from "../lib/wallet-registry";

/**
 * A launch the scan has not seen yet needs its metadata, which is a read. One
 * per push would let a burst of launches become a burst of RPC, so unknown
 * mints coalesce into a single reload.
 */
const RELOAD_DEBOUNCE_MS = 4_000;

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

/**
 * Placeholders while the first read is in flight.
 *
 * A slow RPC used to render an empty column, which reads as "there are no
 * coins" — the one message the board must never send by accident. Cards of
 * roughly the right shape say "loading" without a spinner, and keep the layout
 * from jumping when the real ones arrive.
 */
function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div aria-hidden data-testid="board-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card coin-card skeleton">
          <div className="skeleton-line" style={{ width: "60%" }} />
          <div className="skeleton-line" style={{ width: "35%" }} />
          <div className="progress">
            <span style={{ width: "0%" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function BoardScreen() {
  const [buckets, setBuckets] = useState<Buckets>(emptyBuckets());
  const [error, setError] = useState<string | null>(null);
  /** The indexer was configured and did not answer; we are on the chain path. */
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [liveStatus, setLiveStatus] = useState<LiveStatus | null>(null);

  const load = useCallback(async (): Promise<Buckets> => {
    const { value, degraded } = await readPreferApi<Buckets>({
      apiConfigured: apiConfigured(),
      // The indexer buckets server-side; ask for all three at once.
      fromApi: async () => {
        const [fresh, nearly, done] = await Promise.all([
          launchpadApi.board("new"),
          launchpadApi.board("graduating"),
          launchpadApi.board("graduated"),
        ]);
        return { new: fresh, graduating: nearly, graduated: done };
      },
      // No indexer, or the indexer is down: read the board from the program
      // itself — bucketed, ranked and capped before any metadata is fetched,
      // so the cost does not grow with the launchpad. Discovery cannot come
      // from localStorage; that showed each visitor only their own history and
      // hid every coin created elsewhere. It stays only as a HINT, for a coin
      // too new to be in the scan's snapshot.
      fromChain: () => fetchBoardFromChain(getConnection(), { hints: loadLocalCoins() }),
    });
    setDegraded(degraded);
    return value;
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

  // Live updates: every column refreshes when the feed reports activity, and
  // on every (re)connection — a stream that dropped has a hole in it, and a
  // hole in a board looks exactly like a quiet market.
  useEffect(() => {
    const reload = () => {
      load().then(setBuckets).catch(() => {});
    };
    return subscribeLaunchpad(reload, { onResync: reload });
  }, [load]);

  // Live board. One program subscription covers the whole launchpad: every
  // buy, sell, completion and migration arrives as a push (measured at ~1s
  // from send, before the trader's own confirmation returns), so a card's
  // raise and progress move while you are looking at them.
  //
  // A known coin is patched IN PLACE — no refetch, no flicker, and the name
  // it already has is kept. An unknown mint is a coin created since the last
  // load, which needs its metadata; that is a debounced reload rather than a
  // read per push, so a burst of launches cannot turn into a burst of RPC.
  useEffect(() => {
    if (apiConfigured()) return;
    const connection = getConnection();
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (reloadTimer) return;
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        load().then(setBuckets).catch(() => {});
      }, RELOAD_DEBOUNCE_MS);
    };

    // One state commit per frame. During a busy launch this feed delivers
    // tens of updates a second, and a setState per push re-buckets and
    // re-sorts every column that many times — work the screen cannot show.
    // Keyed by mint, so a coin's older state is superseded rather than queued.
    const batch = batchByFrame<DecodedCurve>(
      (curves) => {
        setBuckets((prev) => {
          const byMint = new Map(
            (Object.keys(prev) as BoardBucket[]).flatMap((k) => prev[k]).map((c) => [c.mint, c]),
          );
          const updates = new Map<string, CoinView>();
          for (const curve of curves) {
            const mint = curve.mint.toBase58();
            const known = byMint.get(mint);
            if (!known) {
              scheduleReload();
              continue;
            }
            updates.set(
              mint,
              coinViewFromCurve(mint, curve, {
                name: known.name,
                symbol: known.symbol,
                uri: known.uri,
              }),
            );
          }
          if (updates.size === 0) return prev;
          // Re-bucket as well as re-render: a trade can be the one that
          // pushes a coin past the graduating threshold, and the column it
          // sits in is part of the information.
          const next = { new: [], graduating: [], graduated: [] } as Buckets;
          for (const key of Object.keys(prev) as BoardBucket[]) {
            for (const coin of prev[key]) {
              const view = updates.get(coin.mint) ?? coin;
              next[boardBucket(view)].push(view);
            }
          }
          for (const key of Object.keys(next) as BoardBucket[]) {
            next[key].sort((a, b) => Number(BigInt(b.realSol) - BigInt(a.realSol)));
          }
          return next;
        });
      },
      { key: (c) => c.mint.toBase58() },
    );

    const handle = watchAllCurves(connection, (curve) => batch.push(curve), {
      onStatus: setLiveStatus,
    });
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      batch.stop();
      handle.stop();
    };
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

      {!apiConfigured() && liveStatus && (
        <p className="muted small" data-testid="live-status" data-state={liveStatus}>
          {liveStatus === "live" ? (
            <>
              <span className="live-dot" aria-hidden /> Live — updates as trades
              land on chain.
            </>
          ) : liveStatus === "polling" ? (
            <>This RPC does not push updates; refreshing every few seconds.</>
          ) : (
            <>Connecting…</>
          )}
        </p>
      )}
      {error && <div className="errors">Could not load the board: {error}</div>}
      {degraded && (
        <div className="errors" data-testid="degraded-banner">
          Live feed unavailable — reading the board directly from the chain.
        </div>
      )}

      <div className="board-columns">
        {COLUMNS.map((col) => (
          <section key={col.key} className="board-column" data-testid={`column-${col.key}`}>
            <header className="board-column-head">
              <h2>{col.label}</h2>
              <span className="muted small">{col.blurb}</span>
            </header>
            <div className="board-column-body">
              {loading ? (
                <SkeletonCards />
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
