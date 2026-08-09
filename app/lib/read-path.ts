/**
 * Where a read comes from, and what it means when that changes.
 *
 * The app has two ways to answer "what is happening on the launchpad": the
 * indexer's API, and a direct scan of the chain from the browser. They are not
 * equivalent in cost. The chain-direct path is correct for one user and is
 * paid PER VIEWER — every browser scanning the program, holding its own
 * subscription, re-reading to stay honest. At a crowd that is the RPC bill,
 * and then the rate limit, and then the site (SCALING.md).
 *
 * So the rule is: when an indexer is configured, it serves every read it can,
 * and the chain-direct path becomes a FALLBACK rather than a parallel system.
 * Two things follow, and they are why this is a module rather than an `if`:
 *
 *  - falling back must be **visible**. A silent fallback is the worst of both:
 *    the RPC cost returns, nobody knows why the site got slow, and the outage
 *    that caused it never gets noticed.
 *  - reading chain-direct when NO indexer is configured is not degraded, it is
 *    the design. Conflating the two would put a scary banner on the normal
 *    zero-config deployment.
 *
 * Some reads have no API form at all — a wallet's own balance, a CPMM pool's
 * live reserves for quoting a swap, and the whole signing path. Those stay
 * chain-direct at any scale, deliberately: the trading path must not
 * centralise.
 */

export type ReadSource = "api" | "chain";

export interface ReadOutcome<T> {
  value: T;
  source: ReadSource;
  /** True only when the API was supposed to serve this and could not. */
  degraded: boolean;
}

export async function readPreferApi<T>(opts: {
  apiConfigured: boolean;
  fromApi: () => Promise<T>;
  fromChain: () => Promise<T>;
  /** Called with the error that forced the fallback, for telemetry. */
  onFallback?: (err: unknown) => void;
}): Promise<ReadOutcome<T>> {
  if (!opts.apiConfigured) {
    return { value: await opts.fromChain(), source: "chain", degraded: false };
  }
  try {
    return { value: await opts.fromApi(), source: "api", degraded: false };
  } catch (err) {
    opts.onFallback?.(err);
    // If the fallback ALSO fails there is nothing left to try, and the caller
    // must see a real error rather than an empty screen — so this throws.
    return { value: await opts.fromChain(), source: "chain", degraded: true };
  }
}
