/**
 * Keeper observability — GATE 2: "observability live (sweeps, balances,
 * proposal anomalies)". The keeper half: structured sweep/failure/balance
 * accounting with per-vault consecutive-failure escalation (spec 6.5
 * "alert on repeated failure"). Proposal anomalies live in the backend
 * (chain-reader detectProposalAnomalies) next to the chain state they
 * inspect.
 *
 * The monitor is pure accounting over injected events — no transport.
 * Wire `onAlert` to whatever pages the operator; scrape `snapshot()` from
 * a /metrics-style endpoint. All lamport sums are bigint (INV-6).
 */
import type { PublicKey } from "@solana/web3.js";
import type { SweepResult } from "@daofun/sdk";
import { sweepVault, type KeeperDeps } from "./keeper";

export interface KeeperAlert {
  vault: string;
  consecutiveFailures: number;
  error: string;
}

export interface MonitorOptions {
  /** Escalate when a vault's consecutive failures reach this count. */
  alertAfter?: number;
  onAlert: (alert: KeeperAlert) => void;
}

export interface MetricsSnapshot {
  sweeps: number;
  /** Σ grossLamports across recorded sweeps (stringified bigint). */
  sweptLamports: string;
  failures: number;
  alerts: number;
  /** Latest observed balance per vault (stringified bigint). */
  vaultBalances: Record<string, string>;
  /** Current consecutive-failure streak per vault (non-zero only). */
  failureStreaks: Record<string, number>;
}

export class KeeperMonitor {
  private readonly alertAfter: number;
  private readonly onAlert: (alert: KeeperAlert) => void;
  private sweeps = 0;
  private sweptLamports = 0n;
  private failures = 0;
  private alerts = 0;
  private readonly balances = new Map<string, bigint>();
  private readonly streaks = new Map<string, number>();

  constructor(opts: MonitorOptions) {
    this.alertAfter = opts.alertAfter ?? 3;
    this.onAlert = opts.onAlert;
  }

  recordSweep(result: SweepResult): void {
    this.sweeps += 1;
    this.sweptLamports += result.grossLamports;
    this.streaks.delete(result.vault.toBase58());
  }

  /** A tick that saw the vault healthy (even with nothing to sweep). */
  recordHealthy(vault: PublicKey): void {
    this.streaks.delete(vault.toBase58());
  }

  recordFailure(vault: PublicKey, error: unknown): void {
    this.failures += 1;
    const key = vault.toBase58();
    const streak = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, streak);
    // fire exactly on the crossing: one escalation per outage
    if (streak === this.alertAfter) {
      this.alerts += 1;
      this.onAlert({
        vault: key,
        consecutiveFailures: streak,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  recordVaultBalance(vault: PublicKey, lamports: bigint): void {
    this.balances.set(vault.toBase58(), lamports);
  }

  snapshot(): MetricsSnapshot {
    return {
      sweeps: this.sweeps,
      sweptLamports: this.sweptLamports.toString(),
      failures: this.failures,
      alerts: this.alerts,
      vaultBalances: Object.fromEntries(
        [...this.balances].map(([k, v]) => [k, v.toString()]),
      ),
      failureStreaks: Object.fromEntries(this.streaks),
    };
  }
}

/**
 * runTick with the monitor wired in: same per-vault failure isolation,
 * plus sweep/healthy/failure accounting per vault.
 */
export async function runMonitoredTick(
  vaults: PublicKey[],
  deps: KeeperDeps,
  monitor: KeeperMonitor,
): Promise<SweepResult[]> {
  const results: SweepResult[] = [];
  for (const vault of vaults) {
    try {
      const result = await sweepVault(vault, deps);
      if (result) {
        monitor.recordSweep(result);
        results.push(result);
      } else {
        monitor.recordHealthy(vault); // idempotent no-op tick
      }
    } catch (e) {
      monitor.recordFailure(vault, e);
    }
  }
  return results;
}
