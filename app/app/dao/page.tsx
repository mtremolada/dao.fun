"use client";

/**
 * DAO dashboard — spec 6.7, server-less (D-033). `?realm=` + `?vault=` select
 * the DAO (the Squads vault is not derivable from the realm; it hangs off the
 * multisig createKey), `?mint=` is the community mint to deposit, and
 * `?wallet=` selects whose vote power to show. All values are read directly
 * from the chain in the browser via the SDK reader over the user's RPC.
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import type { DaoDashboard } from "@daofun/sdk/chain-reader";
import { getChainReader } from "../../lib/rpc";
import { DepositActions } from "../../components/deposit-actions";
import { RpcSettings } from "../../components/rpc-settings";

type Status = "idle" | "loading" | "loaded" | "error";

function sol(lamports: number): string {
  const sign = lamports > 0 ? "+" : lamports < 0 ? "-" : "";
  return `${sign}${Math.abs(lamports) / 1e9}`;
}

function DaoInner() {
  const params = useSearchParams();
  const realm = params.get("realm") ?? "";
  const vault = params.get("vault") ?? "";
  const mint = params.get("mint") ?? "";
  const wallet = params.get("wallet") ?? "";

  const [dashboard, setDashboard] = useState<DaoDashboard | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!realm || !vault) {
      setStatus("idle");
      return;
    }
    let realmKey: PublicKey;
    let vaultKey: PublicKey;
    let walletKey: PublicKey | undefined;
    try {
      realmKey = new PublicKey(realm);
      vaultKey = new PublicKey(vault);
      walletKey = wallet ? new PublicKey(wallet) : undefined;
    } catch {
      setStatus("error");
      setError("realm, ?vault= and ?wallet= must be valid pubkeys");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    void (async () => {
      try {
        const d = await getChainReader().getDashboard(realmKey, {
          vault: vaultKey,
          wallet: walletKey,
        });
        if (cancelled) return;
        if (!d) {
          setStatus("error");
          setError("not found");
          return;
        }
        setDashboard(d);
        setStatus("loaded");
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [realm, vault, wallet]);

  if (!realm) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Missing ?realm= — pass the DAO&apos;s realm address.
        </p>
      </>
    );
  }
  if (!vault) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Missing ?vault= — pass the DAO&apos;s Squads vault address.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>{dashboard?.realmName ?? "DAO dashboard"}</h1>
      <RpcSettings />
      <p className="muted" style={{ wordBreak: "break-all" }}>
        realm {realm}
        <br />
        vault {vault}
      </p>
      {status === "loading" && <p className="muted">Reading chain…</p>}
      {status === "error" && (
        <p className="errors" data-testid="dashboard-error">
          {error}
        </p>
      )}

      {dashboard && (
        <>
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
      )}

      {mint ? (
        <DepositActions realm={realm} governingTokenMint={mint} />
      ) : (
        <p className="muted">
          pass ?mint= (the community mint) to deposit for vote weight
        </p>
      )}
    </>
  );
}

export default function DaoPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <DaoInner />
    </Suspense>
  );
}
