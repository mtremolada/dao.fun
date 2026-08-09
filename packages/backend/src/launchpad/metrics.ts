/**
 * What the operator looks at when someone says "it feels broken".
 *
 * The single most important number here is **indexer lag in slots**: the
 * difference between the chain's head and the last slot we folded in. Every
 * other symptom — a stale board, a trade that never appears in the tape, a
 * chart with a flat tail — is downstream of it, and none of them are
 * distinguishable from "the market is quiet" without this number.
 *
 * Counters are cumulative (they only ever go up, so a scraper can difference
 * them) and rates are computed over a rolling window, because a cumulative
 * count alone cannot answer "is it happening NOW".
 *
 * Deliberately dependency-free: gauges are injected as functions, so this
 * module knows nothing about SQLite, the RPC or the keeper, and the tests
 * need none of them.
 */

/** Timestamps of recent events, bounded so a busy day cannot grow memory. */
class RateWindow {
  private readonly at: number[] = [];
  constructor(
    private readonly windowMs: number,
    private readonly cap = 20_000,
  ) {}

  mark(now: number): void {
    this.at.push(now);
    if (this.at.length > this.cap) this.at.splice(0, this.at.length - this.cap);
  }

  /** Events per second over the window. */
  perSecond(now: number): number {
    const cutoff = now - this.windowMs;
    // The array is append-only in time order, so a single scan from the front
    // is enough and the survivors stay in order.
    let i = 0;
    while (i < this.at.length && this.at[i]! < cutoff) i++;
    if (i > 0) this.at.splice(0, i);
    return this.at.length / (this.windowMs / 1000);
  }
}

export interface MetricsGauges {
  /** Currently connected SSE clients. */
  sseClients?: () => number;
  /** Highest slot the store has folded in. */
  indexedSlot?: () => number;
  /** The chain's head. Null when it cannot be read — which is itself a signal. */
  chainSlot?: () => Promise<number | null>;
  /** Keeper wallet balance; a drained keeper silently stops graduations. */
  keeperLamports?: () => Promise<number | null>;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  indexedSlot: number | null;
  chainSlot: number | null;
  /** chainSlot - indexedSlot. Null when either is unknown. */
  indexerLagSlots: number | null;
  sseClients: number;
  sseRejectedTotal: number;
  eventsPublishedTotal: number;
  eventsPerSecond: number;
  rpcProxyCallsTotal: number;
  rpcProxyErrorsTotal: number;
  rpcProxyCallsPerSecond: number;
  upstreamCallsTotal: number;
  upstreamErrorsTotal: number;
  upstreamCallsPerSecond: number;
  keeperLamports: number | null;
}

export class Metrics {
  private startedAt: number;
  private counters = {
    sseRejected: 0,
    eventsPublished: 0,
    rpcProxyCalls: 0,
    rpcProxyErrors: 0,
    upstreamCalls: 0,
    upstreamErrors: 0,
  };
  private eventRate: RateWindow;
  private proxyRate: RateWindow;
  private upstreamRate: RateWindow;

  constructor(
    private readonly gauges: MetricsGauges = {},
    private readonly now: () => number = () => Date.now(),
    windowMs = 60_000,
  ) {
    this.startedAt = this.now();
    this.eventRate = new RateWindow(windowMs);
    this.proxyRate = new RateWindow(windowMs);
    this.upstreamRate = new RateWindow(windowMs);
  }

  /** An SSE subscription refused by a cap — the shape of an abuse attempt. */
  sseRejected(): void {
    this.counters.sseRejected++;
  }

  eventPublished(): void {
    this.counters.eventsPublished++;
    this.eventRate.mark(this.now());
  }

  /** A browser call through our JSON-RPC proxy. */
  rpcProxyCall(ok: boolean): void {
    this.counters.rpcProxyCalls++;
    if (!ok) this.counters.rpcProxyErrors++;
    this.proxyRate.mark(this.now());
  }

  /** A call WE made to the upstream RPC (indexer, keeper) — the billed one. */
  upstreamCall(ok: boolean): void {
    this.counters.upstreamCalls++;
    if (!ok) this.counters.upstreamErrors++;
    this.upstreamRate.mark(this.now());
  }

  async snapshot(): Promise<MetricsSnapshot> {
    const now = this.now();
    const indexedSlot = this.gauges.indexedSlot?.() ?? null;
    // A gauge that throws must not take the metrics endpoint down with it —
    // an observability surface that fails when things are going wrong is
    // worse than none, because it fails exactly when it is needed.
    const chainSlot = await safe(this.gauges.chainSlot);
    const keeperLamports = await safe(this.gauges.keeperLamports);
    return {
      uptimeSeconds: Math.floor((now - this.startedAt) / 1000),
      indexedSlot,
      chainSlot,
      indexerLagSlots:
        chainSlot === null || indexedSlot === null || indexedSlot === 0
          ? null
          : Math.max(0, chainSlot - indexedSlot),
      sseClients: this.gauges.sseClients?.() ?? 0,
      sseRejectedTotal: this.counters.sseRejected,
      eventsPublishedTotal: this.counters.eventsPublished,
      eventsPerSecond: round(this.eventRate.perSecond(now)),
      rpcProxyCallsTotal: this.counters.rpcProxyCalls,
      rpcProxyErrorsTotal: this.counters.rpcProxyErrors,
      rpcProxyCallsPerSecond: round(this.proxyRate.perSecond(now)),
      upstreamCallsTotal: this.counters.upstreamCalls,
      upstreamErrorsTotal: this.counters.upstreamErrors,
      upstreamCallsPerSecond: round(this.upstreamRate.perSecond(now)),
      keeperLamports,
    };
  }
}

async function safe<T>(f: (() => Promise<T | null>) | undefined): Promise<T | null> {
  if (!f) return null;
  try {
    return await f();
  } catch {
    return null;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Prometheus text exposition. Present so that wiring an alert (LAUNCH.md
 * L-61) is a scrape config rather than a code change — the alerts themselves
 * need a destination, which is not something devnet can decide.
 */
export function toPrometheus(s: MetricsSnapshot): string {
  const lines: string[] = [];
  const g = (name: string, help: string, value: number | null, type = "gauge") => {
    if (value === null) return; // absent, not zero — zero would read as healthy
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };
  g("daofun_indexer_lag_slots", "Chain head minus last indexed slot.", s.indexerLagSlots);
  g("daofun_indexed_slot", "Last slot folded into the store.", s.indexedSlot);
  g("daofun_chain_slot", "Chain head as last read.", s.chainSlot);
  g("daofun_sse_clients", "Connected SSE clients.", s.sseClients);
  g("daofun_sse_rejected_total", "SSE subscriptions refused by a cap.", s.sseRejectedTotal, "counter");
  g("daofun_events_published_total", "Launchpad events fanned out.", s.eventsPublishedTotal, "counter");
  g("daofun_events_per_second", "Events fanned out per second (1m).", s.eventsPerSecond);
  g("daofun_rpc_proxy_calls_total", "Browser calls through the JSON-RPC proxy.", s.rpcProxyCallsTotal, "counter");
  g("daofun_rpc_proxy_errors_total", "Proxy calls refused or failed.", s.rpcProxyErrorsTotal, "counter");
  g("daofun_upstream_calls_total", "Calls we made to the upstream RPC.", s.upstreamCallsTotal, "counter");
  g("daofun_upstream_errors_total", "Upstream RPC calls that failed.", s.upstreamErrorsTotal, "counter");
  g("daofun_upstream_calls_per_second", "Upstream RPC calls per second (1m).", s.upstreamCallsPerSecond);
  g("daofun_keeper_lamports", "Keeper wallet balance in lamports.", s.keeperLamports);
  g("daofun_uptime_seconds", "Process uptime.", s.uptimeSeconds);
  return lines.join("\n") + "\n";
}
