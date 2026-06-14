"use client";

/**
 * DAO dashboard — fully client-side (no server). Everything is reconstructable
 * from the token MINT alone, so a DAO's votes, proposals and DEX-paid bounty
 * reimbursements survive launch and can't be lost: ?mint= derives the
 * realm/governance/treasury OFFLINE (deterministic PDAs) and lists every
 * proposal of that DAO straight from chain (getProposalsByGovernance).
 *
 * It also VERIFIES the DAO's custody structure + governance config in the
 * browser (the buyer's trust primitive), shows vault balance / sweep history /
 * vote power, and exposes a permissionless "Collect fees → vault" button
 * (INV-2). The Squads vault is the one address not derivable from the realm, so
 * the treasury view is shown when ?vault= is supplied (legacy ?realm=&vault=
 * still works). Other params: ?wallet=&ms=.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../lib/solana";
import {
  daoFromMint,
  getDashboard,
  listProposals,
  verifyDao,
  type DaoAddresses,
  type DaoDashboard,
  type DaoVerification,
  type ProposalSummary,
} from "../lib/chain";
import { collectFees } from "../lib/collect";
import { depositFlow, type FlowState } from "../lib/governance-actions";
import { useWallet } from "./wallet-provider";

// pump tokens have 6 decimals — let holders enter whole tokens.
const TOKEN_DECIMALS = 6;

function sol(lamports: number): string {
  const sign = lamports > 0 ? "+" : lamports < 0 ? "-" : "";
  return `${sign}${Math.abs(lamports) / 1e9}`;
}

export function DaoScreen() {
  const q = useSearchParams();
  const { sender, openModal } = useWallet();
  const mint = q.get("mint") ?? "";
  const realmParam = q.get("realm") ?? "";
  const vault = q.get("vault") ?? "";
  const wallet = q.get("wallet") ?? "";
  const ms = q.get("ms") ?? "";

  // Deterministic + offline: the DAO's addresses straight from the mint (no RPC).
  const dao = useMemo<DaoAddresses | null>(() => {
    if (!mint) return null;
    try {
      return daoFromMint(new PublicKey(mint));
    } catch {
      return null;
    }
  }, [mint]);
  const mintInvalid = mint !== "" && dao === null;
  const realm = dao?.realm ?? realmParam;
  const hasTreasuryInputs = Boolean(realm && vault);

  const [dashboard, setDashboard] = useState<DaoDashboard | null>(null);
  const [verification, setVerification] = useState<DaoVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [proposalsError, setProposalsError] = useState<string | null>(null);

  const [collecting, setCollecting] = useState(false);
  const [collectSig, setCollectSig] = useState<string | null>(null);
  const [collectError, setCollectError] = useState<string | null>(null);

  const [depositAmt, setDepositAmt] = useState("");
  const [depositState, setDepositState] = useState<FlowState | null>(null);

  // The durable, per-token proposal list (votes + bounty reimbursements).
  useEffect(() => {
    if (!mint || mintInvalid) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listProposals(getConnection(), new PublicKey(mint));
        if (!cancelled) setProposals(list);
      } catch (e) {
        if (!cancelled) setProposalsError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mint, mintInvalid]);

  // Optional Squads treasury view (vault address is not derivable).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!hasTreasuryInputs) {
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
  }, [realm, vault, wallet, ms, hasTreasuryInputs]);

  async function onDeposit() {
    if (!sender) {
      openModal();
      return;
    }
    if (!dashboard?.communityMint) return;
    const tokens = Number(depositAmt);
    if (!(tokens > 0)) return;
    const base = BigInt(Math.floor(tokens * 10 ** TOKEN_DECIMALS));
    await depositFlow(
      {
        realm,
        governingTokenMint: dashboard.communityMint,
        amount: base.toString(),
      },
      { connection: getConnection(), sender, onState: setDepositState },
    );
  }

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

  // Nothing to load from: neither a mint nor a legacy realm+vault pair.
  if (!mint && !hasTreasuryInputs) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Missing parameters — pass ?mint= (the token mint) to load the DAO, or
          ?realm=&amp;vault= for the treasury dashboard.
        </p>
      </>
    );
  }

  if (mintInvalid) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Invalid ?mint= address.
        </p>
      </>
    );
  }

  return (
    <>
      <h1>{dashboard?.realmName ?? "Token DAO"}</h1>

      {dao && (
        <p
          className="muted"
          style={{ wordBreak: "break-all" }}
          data-testid="dao-addresses"
        >
          mint {mint}
          <br />
          realm <span data-testid="dao-realm">{dao.realm}</span>
          <br />
          governance {dao.governance}
          <br />
          treasury {dao.nativeTreasury}
        </p>
      )}

      {/* Proposals — votes + DEX-paid bounties, straight from chain */}
      {mint && (
        <>
          <h2>Proposals</h2>
          {proposalsError ? (
            <p className="muted" data-testid="proposals-error">
              Couldn&apos;t load proposals ({proposalsError}). Pass ?rpc= with
              your own endpoint.
            </p>
          ) : proposals === null ? (
            <p className="muted">Loading proposals…</p>
          ) : proposals.length === 0 ? (
            <p className="muted" data-testid="proposals-empty">
              No proposals yet for this DAO.
            </p>
          ) : (
            <table data-testid="proposals">
              <thead>
                <tr>
                  <th>proposal</th>
                  <th>state</th>
                  <th>claim</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map((p) => (
                  <tr key={p.address}>
                    <td style={{ wordBreak: "break-all" }}>
                      <Link href={`/proposal?id=${p.address}`}>
                        {p.name || p.address}
                      </Link>
                    </td>
                    <td>{p.state}</td>
                    <td>{p.claimStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {hasTreasuryInputs && !loaded && (
        <p className="muted">Loading treasury…</p>
      )}

      {hasTreasuryInputs && loaded && !dashboard && (
        <p className="errors" data-testid="dashboard-error">
          {error ?? "not found"}
        </p>
      )}

      {dashboard && (
        <>
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
          <div className="stat" data-testid="vault-balance">
            <div className="label">Treasury vault</div>
            <div className="value">{dashboard.vaultBalanceLamports / 1e9} SOL</div>
            <div className="sub">{dashboard.vaultBalanceLamports} lamports</div>
          </div>

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
            <div className="stat" data-testid="vote-power">
              <div className="label">Deposited governing tokens (raw)</div>
              <div className="value">{dashboard.votePower.depositedTokens}</div>
              <div className="sub">{dashboard.votePower.wallet}</div>
            </div>
          ) : (
            <p className="muted" data-testid="vote-power">
              pass ?wallet= to see a holder&apos;s deposited vote power
            </p>
          )}

          <h2>Get voting power</h2>
          <p className="muted">
            Vote weight = governing tokens you deposit into the realm. Deposit your{" "}
            {dashboard.realmName} tokens here to be able to vote (withdrawable later).
          </p>
          <input
            className="dao-input"
            type="number"
            min={0}
            step="0.000001"
            placeholder="amount of tokens"
            data-testid="deposit-amount"
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            style={{ maxWidth: "16rem", marginRight: "0.5rem" }}
          />
          <button
            className="button"
            type="button"
            data-testid="deposit-button"
            disabled={
              !dashboard.communityMint ||
              depositState?.phase === "building" ||
              depositState?.phase === "sending" ||
              !(Number(depositAmt) > 0)
            }
            onClick={() => void onDeposit()}
          >
            {sender ? "Deposit for voting power" : "Connect wallet to deposit"}
          </button>
          {depositState && (
            <p data-testid="deposit-status" data-phase={depositState.phase}>
              {depositState.phase === "done"
                ? "Deposited ✅ — you can vote now"
                : depositState.phase === "error"
                  ? `Deposit failed: ${depositState.error}`
                  : depositState.phase === "sending"
                    ? "Confirm in your wallet…"
                    : "Building transaction…"}
            </p>
          )}
        </>
      )}
    </>
  );
}
