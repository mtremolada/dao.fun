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

export class SseHub {
  private clients = new Set<ServerResponse>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: { heartbeatMs?: number; maxClients?: number } = {}) {}

  /** Attach a request as a subscriber. Returns false if the cap is hit. */
  subscribe(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.clients.size >= (this.opts.maxClients ?? 1000)) {
      res.writeHead(503).end();
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
    this.ensureHeartbeat();
    const drop = () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
    req.on("close", drop);
    res.on("error", drop);
    return true;
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
