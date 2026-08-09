"use client";

/**
 * Your Profile — the launcher's control room. Everything here reads from
 * chain, so it works with only an RPC and shows the truth rather than an
 * indexer's cached opinion.
 *
 * The two actions are the ones a launcher actually needs and cannot do from
 * the coin page: claim the creator fees their coins have earned, and crank a
 * finished curve into its Raydium pool. Both are permissionless on chain —
 * the program fixes every destination — so the buttons are safe to show even
 * when the connected wallet is not the creator.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "./wallet-provider";
import { getConnection } from "../lib/solana";
import { claimCreatorFees, graduate, type ActionCtx } from "../lib/coin-actions";
import { fetchClaimableCreatorFees, fetchLaunchesByCreator } from "../lib/profile";
import { rememberCoin } from "../lib/chain-coin";
import type { CoinView } from "../lib/launchpad-api";
import type { SendState } from "../lib/tx-sender";
import { explorerAddress, explorerTx } from "../lib/cluster";
import { truncateAddress } from "../lib/wallet-registry";

const SOL = (lamports: bigint | number) =>
  (Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 });

function LaunchRow({
  coin,
  onGraduate,
  busy,
}: {
  coin: CoinView;
  onGraduate: (coin: CoinView) => void;
  busy: boolean;
}) {
  const pct = Math.round(coin.progressBps / 100);
  const state = coin.migrated ? "verified" : coin.complete ? "amber" : "missing";
  return (
    <div className="card launch-row" data-testid={`launch-${coin.symbol}`}>
      <div className="coin-card-head">
        <strong>{coin.name}</strong>
        <span className="ticker">${coin.symbol}</span>
        <span className="badge" data-state={state}>
          {coin.migrated ? "Graduated" : coin.complete ? "Ready to graduate" : `${pct}%`}
        </span>
      </div>
      <div className="progress" aria-label="graduation progress">
        <span style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="muted small">Raised {SOL(BigInt(coin.realSol))} SOL</div>
      <div className="launch-actions">
        <Link className="button" href={`/coin?mint=${coin.mint}`}>
          Open terminal
        </Link>
        {coin.complete && !coin.migrated && (
          <button
            className="button primary"
            disabled={busy}
            onClick={() => onGraduate(coin)}
            data-testid={`graduate-${coin.symbol}`}
          >
            Graduate now
          </button>
        )}
        {coin.migrated && coin.poolState && (
          <a
            className="button"
            href={explorerAddress(coin.poolState)}
            target="_blank"
            rel="noreferrer"
          >
            Raydium pool
          </a>
        )}
      </div>
    </div>
  );
}

export function ProfileScreen() {
  const { account, wallet, getSigner, openModal } = useWallet();
  const address = account?.address ?? null;

  const [launches, setLaunches] = useState<CoinView[]>([]);
  const [claimable, setClaimable] = useState<bigint | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<SendState | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!address) {
      setLaunches([]);
      setClaimable(null);
      setSolBalance(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    const connection = getConnection();
    Promise.all([
      fetchLaunchesByCreator(connection, address),
      fetchClaimableCreatorFees(connection, address),
      connection.getBalance(new PublicKey(address)),
    ])
      .then(([l, c, b]) => {
        if (!live) return;
        setLaunches(l);
        l.forEach((coin) => rememberCoin(coin.mint));
        setClaimable(c);
        setSolBalance(b);
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [address, tick]);

  /** Both actions share one shape: (coin, ctx) -> SendState. */
  async function runAction(
    fn: (coin: CoinView, ctx: ActionCtx) => Promise<SendState>,
    coin: CoinView,
  ) {
    if (!wallet || !account) {
      openModal();
      return;
    }
    const signer = getSigner();
    if (!signer) {
      setState({ phase: "failed", reason: "rpc-error", message: "This wallet cannot sign transactions." });
      return;
    }
    setBusy(true);
    setState(null);
    try {
      const st = await fn(coin, {
        connection: getConnection(),
        wallet: signer,
        onState: setState,
      });
      if (st.phase === "confirmed") refresh();
    } catch (e) {
      setState({ phase: "failed", reason: "rpc-error", message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!address) {
    return (
      <div className="card" style={{ maxWidth: 560, margin: "1.5rem auto" }}>
        <h1>Your profile</h1>
        <p className="muted">
          Connect a wallet to see the coins you have launched, claim your
          creator fees, and graduate finished curves.
        </p>
        <button className="button primary" onClick={openModal} data-testid="profile-connect">
          Connect wallet
        </button>
      </div>
    );
  }

  return (
    <div className="profile">
      <div className="card">
        <h1>Your profile</h1>
        <dl className="kv">
          <div className="kv-row">
            <dt>Wallet</dt>
            <dd>
              <a href={explorerAddress(address)} target="_blank" rel="noreferrer">
                {truncateAddress(address, 8, 8)}
              </a>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Balance</dt>
            <dd data-testid="profile-balance">
              {solBalance === null ? "—" : `${SOL(solBalance)} SOL`}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Launches</dt>
            <dd data-testid="profile-launch-count">{launches.length}</dd>
          </div>
        </dl>
      </div>

      <div className="card">
        <h2>Creator fees</h2>
        <p className="muted small">
          Every trade on a coin you created pays you a fee. They pool in one
          vault across all your launches — claim any time; the payout always
          goes to the creator.
        </p>
        <p className="creator-fees" data-testid="claimable-fees">
          <strong>{claimable === null ? "—" : `${SOL(claimable)} SOL`}</strong> claimable
        </p>
        <button
          className="button primary"
          disabled={busy || claimable === null || claimable === 0n || launches.length === 0}
          onClick={() => launches[0] && void runAction(claimCreatorFees, launches[0])}
          data-testid="claim-fees"
        >
          {busy ? "Working…" : "Claim fees"}
        </button>
      </div>

      <h2>Your launches</h2>
      {error && <div className="errors">Could not read your launches: {error}</div>}
      {loading ? (
        <p className="muted">Loading…</p>
      ) : launches.length === 0 ? (
        <div className="card empty">
          <p>You haven&apos;t launched a coin yet.</p>
          <Link className="button primary" href="/create">
            Create a token
          </Link>
        </div>
      ) : (
        <div className="launch-list" data-testid="your-launches">
          {launches.map((coin) => (
            <LaunchRow
              key={coin.mint}
              coin={coin}
              busy={busy}
              onGraduate={(c) => void runAction(graduate, c)}
            />
          ))}
        </div>
      )}

      {state && (
        <p
          className="status"
          data-phase={
            state.phase === "confirmed" ? "done" : state.phase === "failed" ? "error" : state.phase
          }
        >
          {state.phase === "confirmed" ? (
            <>
              ✅ Done —{" "}
              {state.signature && (
                <a href={explorerTx(state.signature)} target="_blank" rel="noreferrer">
                  view
                </a>
              )}
            </>
          ) : state.phase === "failed" ? (
            `❌ ${state.message ?? state.reason}`
          ) : (
            `⏳ ${state.phase}…`
          )}
        </p>
      )}
    </div>
  );
}
