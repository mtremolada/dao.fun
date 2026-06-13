"use client";

/**
 * DAO dashboard — fully client-side (no server). Reads vault balance, sweep
 * history, and vote power from the user's RPC; VERIFIES the DAO's custody
 * structure + governance config in the browser (the buyer's trust primitive);
 * and exposes a permissionless "Collect fees → vault" button anyone can click
 * (INV-2: no creator signature; the clicker pays only the tx fee). Addresses
 * come from the query string (?realm=&vault=&wallet=&ms=).
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../lib/solana";
import {
  getDashboard,
  verifyDao,
  type DaoDashboard,
  type DaoVerification,
} from "../lib/chain";
import { collectFees } from "../lib/collect";
import { useWallet } from "./wallet-provider";

function sol(lamports: number): string {
  const sign = lamports > 0 ? "+" : lamports < 0 ? "-" : "";
  return `${sign}${Math.abs(lamports) / 1e9}`;
}

export function DaoScreen() {
  const q = useSearchParams();
  const { sender, openModal } = useWallet();
  const realm = q.get("realm") ?? "";
  const vault = q.get("vault") ?? "";
  const wallet = q.get("wallet") ?? "";
  const ms = q.get("ms") ?? "";

  const [dashboard, setDashboard] = useState<DaoDashboard | null>(null);
  const [verification, setVerification] = useState<DaoVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [collecting, setCollecting] = useState(false);
  const [collectSig, setCollectSig] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!realm || !vault) {
        setLoaded(true);
        return;
      }
      try {
        const conn = getConnection();
        const realmPk = new PublicKey(realm);
        const [d, v] = await Promise.all([
          getDashboard(conn, realmPk, {
            vault: new PublicKey(vault),
            ...(wallet ? { wallet: new PublicKey(wallet) } : {}),
          }),
          verifyDao(conn, realmPk, ms ? { multisigPda: new PublicKey(ms) } : {}).catch(
            () => null,
          ),
        ]);
        if (!cancelled) {
          if (d) setDashboard(d);
          else setError("not found");
          setVerification(v);
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
  }, [realm, vault, wallet, ms]);

  async function onCollect() {
    setCollectError(null);
    setCollectSig(null);
    if (!sender) {
      openModal();
      return;
    }
    setCollecting(true);
    try {
      const sig = await collectFees(getConnection(), sender, new PublicKey(vault));
      setCollectSig(sig);
    } catch (e) {
      setCollectError((e as Error).message);
    } finally {
      setCollecting(false);
    }
  }

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

      {/* Buyer trust primitive: verify custody structure + surface rug risk */}
      {verification && (
        <div data-testid="verify-panel">
          <h2>
            Verify this DAO{" "}
            {verification.ok ? (
              <span className="badge" data-state="verified">
                ✓ custody verified
              </span>
            ) : (
              <span className="badge" data-state="mismatch">
                ⚠ unverified custody
              </span>
            )}
          </h2>
          <ul className="result">
            {Object.entries(verification.checks).map(([k, v]) => (
              <li key={k}>
                {v ? "✅" : "❌"} {k}
              </li>
            ))}
          </ul>
          {verification.config && (
            <p className="muted">
              quorum {verification.config.quorumPercent ?? "?"}% · hold-up{" "}
              {verification.config.holdUpSeconds ?? "?"}s · vote-tipping{" "}
              {verification.config.voteTippingDisabled === false
                ? "ENABLED"
                : "disabled"}
            </p>
          )}
          {verification.riskFlags.length > 0 && (
            <p className="errors" data-testid="risk-flags">
              Risk flags (dangerous but legal): {verification.riskFlags.join(", ")}
            </p>
          )}
          {!ms && (
            <p className="muted">
              Pass <code>?ms=</code> (the Squads multisig) to also verify the
              sole-member custody (INV-7).
            </p>
          )}
        </div>
      )}

      <h2>Vault balance</h2>
      <p data-testid="vault-balance">
        <strong>{dashboard.vaultBalanceLamports / 1e9} SOL</strong>{" "}
        <span className="muted">
          ({dashboard.vaultBalanceLamports} lamports)
        </span>
      </p>

      <h2>Creator fees</h2>
      <p className="muted">
        Anyone can sweep this DAO&apos;s accrued pump creator fees into its
        treasury — you only pay the tx fee, and the destination is fixed to the
        vault (INV-2).
      </p>
      <button
        className="button"
        type="button"
        data-testid="collect-button"
        disabled={collecting}
        onClick={() => void onCollect()}
      >
        {collecting
          ? "Collecting…"
          : sender
            ? "Collect fees → vault"
            : "Connect wallet to collect"}
      </button>
      {collectSig && (
        <p className="muted" data-testid="collect-result" style={{ wordBreak: "break-all" }}>
          Swept ✅ — {collectSig}
        </p>
      )}
      {collectError && (
        <p className="errors" data-testid="collect-error">
          {collectError}
        </p>
      )}

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
