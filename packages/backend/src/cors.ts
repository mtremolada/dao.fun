/**
 * Exact-origin CORS around a bare node:http handler — the pump.fun/raydium
 * pattern (browser talks to the api.* origin directly, not via a same-origin
 * rewrite). Only the configured frontend origins are allowed; credentials are
 * off. A wildcard origin is supported for read-only asset routes (/meta/*)
 * because explorers fetch token metadata cross-origin with no Origin lock.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

export interface CorsOptions {
  /** Allowed browser origins, e.g. ["https://daofun.vercel.app"]. "*" allows any. */
  origins: string[];
}

export function parseOrigins(env: string | undefined): string[] {
  return (env ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowOrigin(reqOrigin: string | undefined, allowed: string[]): string | null {
  if (allowed.includes("*")) return "*";
  if (reqOrigin && allowed.includes(reqOrigin)) return reqOrigin;
  return null;
}

export function withCors(handler: RequestListener, options: CorsOptions): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    const reqOrigin = req.headers.origin;
    const origin = allowOrigin(reqOrigin, options.origins);
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      if (origin !== "*") res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(origin ? 204 : 403);
      res.end();
      return;
    }
    handler(req, res);
  };
}
