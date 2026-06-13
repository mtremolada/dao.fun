"use client";

/**
 * DAO dashboard — fully client-side (no server). Reads vault balance, sweep
 * history, and lockup-weighted vote power from the user's RPC. Addresses
 * come from the query string (?realm=&vault=&wallet=); the Squads vault is
 * not derivable from the realm, so it must be supplied.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../lib/solana";
import { getDashboard, type DaoDashboard } from "../lib/chain";

function sol(lamports: number): string {
  const sign = lamports > 0 ? "+" : lamports < 0 ? "-" : "";
  return `${sign}${Math.abs(lamports) / 1e9}`;
}

export function DaoScreen() {
  const q = useSearchParams();
  const realm = q.get("realm") ?? "";
  const vault = q.get("vault") ?? "";
  const wallet = q.get("wallet") ?? "";

  const [dashboard, setDashboard] = useState<DaoDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!realm || !vault) {
        setLoaded(true);
        return;
      }
      try {
        const d = await getDashboard(getConnection(), new PublicKey(realm), {
          vault: new PublicKey(vault),
          ...(wallet ? { wallet: new PublicKey(wallet) } : {}),
        });
        if (!cancelled) {
          if (d) setDashboard(d);
          else setError("not found");
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
      if (!cancelled) setLoaded(true);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [realm, vault, wallet]);

  if (!realm || !vault) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Missing ?realm= and ?vault= — pass the realm and the DAO&apos;s
          Squads vault address.
        </p>
      </>
    );
  }

  if (!loaded) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="muted">Loading…</p>
      </>
    );
  }

  if (!dashboard) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          {error ?? "not found"}
        </p>
      </>
    );
  }

  return (
    <>
      <h1>{dashboard.realmName}</h1>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        realm {dashboard.realm}
        <br />
        vault {dashboard.vault}
      </p>

      <h2>Vault balance</h2>
      <p data-testid="vault-balance">
        <strong>{dashboard.vaultBalanceLamports / 1e9} SOL</strong>{" "}
        <span className="muted">
          ({dashboard.vaultBalanceLamports} lamports)
        </span>
      </p>

      <h2>Sweep history</h2>
      {dashboard.sweeps.length === 0 ? (
        <p className="muted" data-testid="sweep-history">
          no vault activity yet
        </p>
      ) : (
        <table data-testid="sweep-history">
          <thead>
            <tr>
              <th>signature</th>
              <th>time</th>
              <th>vault Δ (SOL)</th>
            </tr>
          </thead>
          <tbody>
            {dashboard.sweeps.map((s) => (
              <tr key={s.signature}>
                <td style={{ wordBreak: "break-all" }}>{s.signature}</td>
                <td>
                  {s.blockTime
                    ? new Date(s.blockTime * 1000).toISOString()
                    : "—"}
                </td>
                <td>{sol(s.deltaLamports)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Vote power</h2>
      {dashboard.votePower ? (
        <p data-testid="vote-power">
          <span className="muted" style={{ wordBreak: "break-all" }}>
            {dashboard.votePower.wallet}
          </span>
          <br />
          deposited governing tokens (raw):{" "}
          <strong>{dashboard.votePower.depositedTokens}</strong>
        </p>
      ) : (
        <p className="muted" data-testid="vote-power">
          pass ?wallet= to see a holder&apos;s deposited vote power
        </p>
      )}
    </>
  );
}
