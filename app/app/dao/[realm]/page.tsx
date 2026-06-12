import type { DaoDashboard } from "@daofun/backend";
import { DashboardLive } from "../../../components/dashboard-live";

const API = process.env.API_URL ?? "http://127.0.0.1:4404";
// Decentralized path: read the dashboard + collect fees entirely in the browser.
const RPC = process.env.NEXT_PUBLIC_RPC_URL;

function sol(lamports: number): string {
  const sign = lamports > 0 ? "+" : lamports < 0 ? "-" : "";
  return `${sign}${Math.abs(lamports) / 1e9}`;
}

/**
 * Dashboard — spec 6.7: vault balance, sweep history, lockup-weighted vote
 * power. All values come from the chain reader (/chain/dao/:realm); the
 * Squads vault is passed as ?vault= (it is not derivable from the realm —
 * it hangs off the multisig createKey) and ?wallet= selects whose vote
 * power to show.
 */
export default async function DaoPage({
  params,
  searchParams,
}: {
  params: Promise<{ realm: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { realm } = await params;
  const q = await searchParams;

  if (!q.vault) {
    return (
      <>
        <h1>DAO dashboard</h1>
        <p className="errors" data-testid="dashboard-error">
          Missing ?vault= — pass the DAO&apos;s Squads vault address.
        </p>
      </>
    );
  }

  // Fully decentralized: read + collect entirely in the browser (no backend).
  if (RPC) {
    return (
      <DashboardLive realm={realm} vault={q.vault} wallet={q.wallet} rpcUrl={RPC} />
    );
  }

  let dashboard: DaoDashboard | null = null;
  let error: string | null = null;
  try {
    const url = new URL(`${API}/chain/dao/${realm}`);
    url.searchParams.set("vault", q.vault);
    if (q.wallet) url.searchParams.set("wallet", q.wallet);
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      dashboard = (await res.json()) as DaoDashboard;
    } else {
      error = ((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`;
    }
  } catch (e) {
    error = (e as Error).message;
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
        <span className="muted">({dashboard.vaultBalanceLamports} lamports)</span>
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
