/**
 * Server-Sent Events hub for the live board/trade feed. One-way server→client,
 * so SSE beats a websocket here: no extra dependency, and EventSource gives the
 * browser automatic reconnection for free (Railway caps a connection at ~15
 * min; the client just reconnects).
 *
 * A comment heartbeat every ≤25 s keeps the connection under Railway's 5-min
 * "no data" cutoff, and `no-store` + `X-Accel-Buffering: no` stop any proxy
 * from buffering the stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface SseMessage {
  event: string;
  data: unknown;
}

/**
 * Who a connection belongs to, for the per-client cap.
 *
 * Behind a proxy the socket address is the PROXY's, so every visitor would
 * share one key and the cap would lock out the whole site the moment a dozen
 * people arrived. `x-forwarded-for`'s leftmost entry is the original client;
 * it is client-supplied and therefore spoofable, which is why this is a
 * fairness cap and not a security boundary — the global cap is the backstop
 * that holds regardless.
 */
export function clientKey(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0]!.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

export interface SseOptions {
  heartbeatMs?: number;
  /** Total connections served. */
  maxClients?: number;
  /**
   * Connections from ONE client. The global cap alone is not a defence: a
   * single browser opening 1,000 connections reaches it by itself and every
   * other viewer is then refused. A per-IP cap is what makes the global one
   * mean "we are full" rather than "somebody is holding the door shut".
   *
   * Generous enough for a real person — several tabs, a phone on the same
   * NAT, a reconnect racing a close — and far below what a script needs.
   */
  maxPerClient?: number;
  /** Called when a cap refuses a connection, so it is visible in metrics. */
  onRejected?: (reason: "global" | "per-client", key: string) => void;
}

export class SseHub {
  private clients = new Set<ServerResponse>();
  private perKey = new Map<string, number>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: SseOptions = {}) {}

  /** Attach a request as a subscriber. Returns false if a cap is hit. */
  subscribe(req: IncomingMessage, res: ServerResponse): boolean {
    const key = clientKey(req);
    if (this.clients.size >= (this.opts.maxClients ?? 1000)) {
      this.opts.onRejected?.("global", key);
      res.writeHead(503).end();
      return false;
    }
    if ((this.perKey.get(key) ?? 0) >= (this.opts.maxPerClient ?? 12)) {
      this.opts.onRejected?.("per-client", key);
      res.writeHead(429).end();
      return false;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    this.clients.add(res);
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    this.ensureHeartbeat();
    let dropped = false;
    const drop = () => {
      // Both `close` and `error` can fire for one connection; without this
      // guard the per-key count decrements twice and the cap leaks away.
      if (dropped) return;
      dropped = true;
      this.clients.delete(res);
      const left = (this.perKey.get(key) ?? 1) - 1;
      if (left <= 0) this.perKey.delete(key);
      else this.perKey.set(key, left);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
    req.on("close", drop);
    res.on("error", drop);
    return true;
  }

  /** Live connections attributed to one client key — for tests and metrics. */
  countFor(key: string): number {
    return this.perKey.get(key) ?? 0;
  }

  broadcast(msg: SseMessage): void {
    const frame = `event: ${msg.event}\ndata: ${JSON.stringify(
      msg.data,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    )}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  close(): void {
    this.stopHeartbeat();
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    const ms = this.opts.heartbeatMs ?? 25_000;
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(": ping\n\n");
        } catch {
          this.clients.delete(res);
        }
      }
    }, ms);
    // Don't keep the process alive just for heartbeats.
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
