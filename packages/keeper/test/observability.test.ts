/**
 * Stage 2 observability (GATE 2: "observability live — sweeps, balances,
 * proposal anomalies"): the keeper monitor. Written before implementation.
 *
 * Contract:
 *  - every sweep is recorded as a structured event + counters (gross
 *    lamports are SUMS of bigints — INV-6, no float drift);
 *  - per-vault consecutive-failure streaks escalate to the alert hook
 *    exactly when they cross the threshold (spec 6.5 "alert on repeated
 *    failure"), and a success resets the streak;
 *  - one vault's failures never block another's accounting (mirrors
 *    runTick's isolation);
 *  - snapshot() is a JSON-able metrics view for /metrics-style scraping.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { KeeperMonitor, runMonitoredTick } from "../src/observability";
import type { KeeperDeps } from "../src/keeper";

const vaultA = Keypair.generate().publicKey;
const vaultB = Keypair.generate().publicKey;

function sweepResult(vault: PublicKey, gross: bigint) {
  return { vault, grossLamports: gross, signature: "sig", venue: "curve" as const };
}

describe("KeeperMonitor", () => {
  it("counts sweeps and sums gross lamports as bigint", () => {
    const m = new KeeperMonitor({ onAlert: () => {} });
    m.recordSweep(sweepResult(vaultA, 100n));
    m.recordSweep(sweepResult(vaultA, 2n ** 53n)); // beyond float precision
    const s = m.snapshot();
    expect(s.sweeps).toBe(2);
    expect(s.sweptLamports).toBe((100n + 2n ** 53n).toString());
  });

  it("escalates exactly when a vault's consecutive failures cross the threshold; success resets", () => {
    const alerts: { vault: string; consecutiveFailures: number }[] = [];
    const m = new KeeperMonitor({ alertAfter: 3, onAlert: (a) => alerts.push(a) });

    m.recordFailure(vaultA, new Error("rpc down"));
    m.recordFailure(vaultA, new Error("rpc down"));
    expect(alerts).toHaveLength(0); // below threshold: no alert
    m.recordFailure(vaultA, new Error("rpc down"));
    expect(alerts).toHaveLength(1); // crossing fires once
    expect(alerts[0]!.vault).toBe(vaultA.toBase58());
    expect(alerts[0]!.consecutiveFailures).toBe(3);
    m.recordFailure(vaultA, new Error("rpc down"));
    expect(alerts).toHaveLength(1); // still the same outage — no re-fire

    m.recordSweep(sweepResult(vaultA, 1n)); // recovery resets the streak
    m.recordFailure(vaultA, new Error("again"));
    m.recordFailure(vaultA, new Error("again"));
    m.recordFailure(vaultA, new Error("again"));
    expect(alerts).toHaveLength(2); // a NEW outage escalates again
  });

  it("streaks are per-vault: one vault's outage never alerts another", () => {
    const alerts: { vault: string }[] = [];
    const m = new KeeperMonitor({ alertAfter: 2, onAlert: (a) => alerts.push(a) });
    m.recordFailure(vaultA, new Error("x"));
    m.recordFailure(vaultB, new Error("x"));
    expect(alerts).toHaveLength(0);
    m.recordFailure(vaultA, new Error("x"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.vault).toBe(vaultA.toBase58());
  });

  it("records vault balance gauges in the snapshot", () => {
    const m = new KeeperMonitor({ onAlert: () => {} });
    m.recordVaultBalance(vaultA, 890_880n);
    m.recordVaultBalance(vaultA, 7_271_603n); // latest wins
    const s = m.snapshot();
    expect(s.vaultBalances[vaultA.toBase58()]).toBe("7271603");
  });
});

describe("runMonitoredTick", () => {
  function depsFor(behavior: Map<string, bigint | Error>): KeeperDeps {
    return {
      keeper: Keypair.generate().publicKey,
      async getAccruedFees(vault) {
        const b = behavior.get(vault.toBase58());
        if (b instanceof Error) throw b;
        return b ?? 0n;
      },
      async getVaultBalance() {
        return 0n;
      },
      async buildCollectIxs() {
        return [] as TransactionInstruction[];
      },
      async sendAndConfirm() {
        return "sig";
      },
      maxAttempts: 1,
      backoffMs: 0,
    };
  }

  it("sweeps are recorded, failures escalate, idle vaults reset their streaks", async () => {
    const alerts: { vault: string }[] = [];
    const monitor = new KeeperMonitor({ alertAfter: 1, onAlert: (a) => alerts.push(a) });
    const behavior = new Map<string, bigint | Error>([
      [vaultA.toBase58(), 500n],
      [vaultB.toBase58(), new Error("boom")],
    ]);
    const results = await runMonitoredTick([vaultA, vaultB], depsFor(behavior), monitor);
    expect(results).toHaveLength(1);
    const s = monitor.snapshot();
    expect(s.sweeps).toBe(1);
    expect(s.failures).toBe(1);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.vault).toBe(vaultB.toBase58());

    // vault B recovers as idle (zero accrued): streak resets, no new alert
    behavior.set(vaultB.toBase58(), 0n);
    await runMonitoredTick([vaultA, vaultB], depsFor(behavior), monitor);
    behavior.set(vaultB.toBase58(), new Error("boom again"));
    await runMonitoredTick([vaultA, vaultB], depsFor(behavior), monitor);
    expect(alerts).toHaveLength(2); // fresh outage, fresh escalation
  });
});
