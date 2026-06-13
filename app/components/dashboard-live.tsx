"use client";

/**
 * Decentralized DAO dashboard: reads vault balance, sweep history, and vote
 * power directly from chain (no backend), and exposes a PERMISSIONLESS
 * "Collect fees" button — anyone can sweep the pump creator fees into the DAO
 * vault (INV-2: no creator signature; the clicker pays only the tx fee; the
 * destination is fixed by the pump program to the DAO's creator vault).
 */
import { useEffect, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PumpFunRail,
  RpcChainReader,
  verifyDaoByRealm,
  type DaoDashboard,
  type DaoVerification,
} from "@daofun/sdk";
import {
  connectWallet,
  discoverWallets,
  makeSigner,
} from "../lib/wallet-standard";
import { signSubmitInstructions } from "../lib/submit";

export function DashboardLive(props: {
  realm: string;
  vault: string;
  wallet?: string | undefined;
  multisigPda?: string | undefined;
  rpcUrl: string;
}) {
  const [dao, setDao] = useState<DaoDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collect, setCollect] = useState<string | null>(null);
  const [verify, setVerify] = useState<DaoVerification | string | null>(null);

  async function runVerify() {
    setVerify("verifying…");
    try {
      const connection = new Connection(props.rpcUrl, "confirmed");
      const v = await verifyDaoByRealm(connection, new PublicKey(props.realm), {
        ...(props.multisigPda
          ? { multisigPda: new PublicKey(props.multisigPda) }
          : {}),
      });
      setVerify(v);
    } catch (e) {
      setVerify(`verify failed: ${(e as Error).message}`);
    }
  }

  async function load() {
    try {
      const connection = new Connection(props.rpcUrl, "confirmed");
      const d = await new RpcChainReader(connection).getDashboard(
        new PublicKey(props.realm),
        {
          vault: new PublicKey(props.vault),
          wallet: props.wallet ? new PublicKey(props.wallet) : undefined,
        },
      );
      if (!d) setError("DAO not found on chain");
      else setDao(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [props.realm, props.vault, props.wallet, props.rpcUrl]);

  async function collectFees() {
    setCollect("connecting wallet…");
    try {
      const w = discoverWallets()[0];
      if (!w) {
        setCollect("No wallet found — install a Solana wallet extension.");
        return;
      }
      const signer = makeSigner(w, await connectWallet(w));
      const connection = new Connection(props.rpcUrl, "confirmed");
      const rail = new PumpFunRail(connection);
      // creator == the DAO's Squads vault (INV-1); the clicker is fee payer only.
      const ixs = await rail.buildCollectFeesIxs(
        new PublicKey(props.vault),
        new PublicKey(signer.address),
      );
      setCollect("submitting…");
      const sig = await signSubmitInstructions(connection, ixs, signer);
      setCollect(`collected — ${sig}`);
      await load();
    } catch (e) {
      setCollect(`failed: ${(e as Error).message}`);
    }
  }

  if (error) {
    return (
      <p className="errors" data-testid="dashboard-error">
        {error}
      </p>
    );
  }
  if (!dao) {
    return <p className="muted">Reading DAO from chain…</p>;
  }

  return (
    <>
      <h1>{dao.realmName}</h1>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        realm {dao.realm}
        <br />
        vault {dao.vault}
      </p>

      <h2>Vault balance</h2>
      <p data-testid="vault-balance">
        <strong>{dao.vaultBalanceLamports / 1e9} SOL</strong>{" "}
        <span className="muted">({dao.vaultBalanceLamports} lamports)</span>
      </p>

      <button
        className="button"
        type="button"
        data-testid="collect-fees"
        onClick={() => void collectFees()}
      >
        Collect fees → vault (permissionless)
      </button>
      {collect && (
        <p className="muted" data-testid="collect-status" style={{ wordBreak: "break-all" }}>
          {collect}
        </p>
      )}

      <h2>Verify this DAO</h2>
      <button
        className="button"
        type="button"
        data-testid="verify-dao"
        onClick={() => void runVerify()}
      >
        Verify from chain
      </button>
      {typeof verify === "string" && (
        <p className="muted" data-testid="verify-status">
          {verify}
        </p>
      )}
      {verify && typeof verify !== "string" && (
        <div data-testid="verify-result">
          <p>
            <span
              className="badge"
              data-state={verify.ok ? "verified" : "mismatch"}
            >
              {verify.ok
                ? "No platform backdoor — structure verified"
                : "STRUCTURE CHECK FAILED — do not trust"}
            </span>
          </p>
          <ul className="muted" style={{ fontSize: "0.85rem" }}>
            {Object.entries(verify.checks).map(([k, ok]) => (
              <li key={k}>
                {ok ? "✓" : "✗"} {k}
              </li>
            ))}
          </ul>
          {verify.config && (
            <p className="muted">
              quorum {verify.config.quorumPercent ?? "?"}% · hold-up{" "}
              {verify.config.holdUpSeconds ?? "?"}s · vote-tipping{" "}
              {verify.config.voteTippingDisabled ? "disabled (good)" : "ENABLED"}
            </p>
          )}
          {verify.riskFlags.length > 0 && (
            <ul className="errors" data-testid="verify-risk">
              {verify.riskFlags.map((f) => (
                <li key={f}>RISK: {f}</li>
              ))}
            </ul>
          )}
          {verify.notes.map((n) => (
            <p key={n} className="muted" style={{ fontSize: "0.8rem" }}>
              {n}
            </p>
          ))}
        </div>
      )}

      <h2>Sweep history</h2>
      {dao.sweeps.length === 0 ? (
        <p className="muted" data-testid="sweep-history">
          no vault activity yet
        </p>
      ) : (
        <table data-testid="sweep-history">
          <tbody>
            {dao.sweeps.map((s) => (
              <tr key={s.signature}>
                <td style={{ wordBreak: "break-all" }}>{s.signature}</td>
                <td>{(s.deltaLamports / 1e9).toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Vote power</h2>
      {dao.votePower ? (
        <p data-testid="vote-power">
          <span className="muted" style={{ wordBreak: "break-all" }}>
            {dao.votePower.wallet}
          </span>
          <br />
          deposited governing tokens (raw):{" "}
          <strong>{dao.votePower.depositedTokens}</strong>
        </p>
      ) : (
        <p className="muted" data-testid="vote-power">
          pass ?wallet= to see a holder&apos;s deposited vote power
        </p>
      )}
    </>
  );
}
