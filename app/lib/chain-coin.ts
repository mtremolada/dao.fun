/**
 * Chain-direct coin reads — the no-backend fallback.
 *
 * The indexer gives us the board and trade history, but a coin's own state
 * lives on chain and needs no server: read the BondingCurve account and the
 * mint's metadata. This is what lets the app launch, display and trade a coin
 * with only an RPC — the backend is an enhancement, never a dependency for
 * the money path.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  boardBucket,
  curvePda,
  decodeCurve,
  type BoardBucket,
  type DecodedCurve,
} from "@daofun/sdk/launchpad";
import type { CoinView } from "./launchpad-api";
import { launchpadProgramId } from "./cluster";

const LOCAL_KEY = "daofun:local-coins";

/**
 * BondingCurve account length. The Config account is owned by the same program
 * and would otherwise decode as a coin, so filtering on size is what keeps the
 * scan honest (profile.ts carries the same constant and the same reason).
 */
export const CURVE_ACCOUNT_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;

/** Mints this browser has launched or visited, so the board isn't empty. */
export function rememberCoin(mint: string): void {
  try {
    const have = loadLocalCoins();
    if (!have.includes(mint)) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify([mint, ...have].slice(0, 60)));
    }
  } catch {
    /* private mode — the board just won't remember */
  }
}

export function loadLocalCoins(): string[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export interface CoinMetadata {
  name: string;
  symbol: string;
  uri: string;
}

const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

export function metadataPdaFor(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()],
    METAPLEX,
  )[0];
}

/** Parse a Metaplex metadata account: key(1) + updateAuthority(32) + mint(32), then borsh strings. */
export function parseMetadata(data: Buffer | Uint8Array | null | undefined): CoinMetadata {
  if (!data) return { name: "", symbol: "", uri: "" };
  const d = Buffer.from(data);
  let o = 1 + 32 + 32;
  const str = () => {
    const len = d.readUInt32LE(o);
    o += 4;
    const s = d.subarray(o, o + len).toString("utf8").replace(/\0+$/, "");
    o += len;
    return s;
  };
  try {
    return { name: str(), symbol: str(), uri: str() };
  } catch {
    return { name: "", symbol: "", uri: "" };
  }
}

/** Shape a decoded curve + metadata into the view the whole app renders. */
export function coinViewFromCurve(
  mint: string,
  c: DecodedCurve,
  meta: CoinMetadata,
): CoinView {
  return {
    mint,
    name: meta.name || "Unknown coin",
    symbol: meta.symbol || "???",
    uri: meta.uri,
    creator: c.creator.toBase58(),
    virtualSol: c.virtualSol.toString(),
    virtualToken: c.virtualToken.toString(),
    realSol: c.realSol.toString(),
    realToken: c.realToken.toString(),
    complete: c.complete,
    migrated: c.migrated,
    poolState: c.migrated ? c.poolState.toBase58() : null,
    createdBlockTime: null,
    progressBps: progressFromCurve(c.realToken, c.complete || c.migrated),
  };
}

async function readMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<CoinMetadata> {
  const info = await connection.getAccountInfo(metadataPdaFor(mint));
  return parseMetadata(info?.data);
}

/**
 * Build a CoinView straight from chain. Returns null when the curve account
 * does not exist (bad mint, or a coin from a different program id).
 */
export async function fetchCoinFromChain(
  connection: Connection,
  mint: string,
): Promise<CoinView | null> {
  let mintKey: PublicKey;
  try {
    mintKey = new PublicKey(mint);
  } catch {
    return null;
  }
  const programId = launchpadProgramId();
  const info = await connection.getAccountInfo(curvePda(mintKey, programId));
  if (!info) return null;
  const c = decodeCurve(info.data);
  const meta = await readMetadata(connection, mintKey).catch(
    (): CoinMetadata => ({ name: "", symbol: "", uri: "" }),
  );
  return coinViewFromCurve(mint, c, meta);
}

/**
 * Every coin on this deployment, straight from chain — curves only.
 *
 * The board used to render only `loadLocalCoins()` — mints this browser had
 * launched or visited. That makes an empty board for every visitor who is not
 * the launcher, and it silently hides coins created anywhere else (a script,
 * another device, another person). A launchpad whose front page shows your own
 * browsing history is not a launchpad, so discovery comes from the program
 * itself and localStorage is demoted to a hint.
 *
 * The `dataSize` filter is CORRECTNESS, not an optimization — the Config
 * account is owned by the same program, and without the size filter it would
 * decode as a coin (the same trap `profile.ts` documents).
 *
 * SCALE, measured rather than assumed: the RPC returns ~440 bytes per coin, so
 * this is 4 KB at ten coins, 0.4 MB at a thousand, and 4.4 MB at ten thousand.
 * A client-side scan cannot be made sublinear — past roughly a thousand coins
 * the answer is the backend indexer (`NEXT_PUBLIC_API_URL`), which serves a
 * bounded, pre-bucketed page instead. This path stays as the no-backend
 * fallback, so it must degrade gracefully rather than pretend.
 */
export async function fetchCurvesFromChain(
  connection: Connection,
): Promise<DecodedCurve[]> {
  const accounts = await connection.getProgramAccounts(launchpadProgramId(), {
    filters: [{ dataSize: CURVE_ACCOUNT_LEN }],
  });
  return accounts.map(({ account }) => decodeCurve(account.data));
}

/**
 * Metadata for a specific set of mints, batched at the 100-account
 * `getMultipleAccounts` ceiling.
 *
 * A missing or unparseable metadata account is NOT a reason to drop the coin:
 * the curve is the source of truth and a nameless coin still trades.
 */
export async function fetchMetadataFor(
  connection: Connection,
  mints: PublicKey[],
): Promise<Map<string, CoinMetadata>> {
  const out = new Map<string, CoinMetadata>();
  for (let i = 0; i < mints.length; i += 100) {
    const slice = mints.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(
      slice.map((m) => metadataPdaFor(m)),
    );
    slice.forEach((mint, j) => {
      let meta: CoinMetadata = { name: "", symbol: "", uri: "" };
      try {
        const info = infos[j];
        if (info) meta = parseMetadata(info.data);
      } catch {
        /* keep the coin, lose the name */
      }
      out.set(mint.toBase58(), meta);
    });
  }
  return out;
}

/** How many coins each board column shows without an indexer. */
export const BOARD_COLUMN_LIMIT = 50;
/**
 * How many remembered-but-unscanned mints are worth an individual read.
 *
 * Only coins genuinely ABSENT from the scan reach this — in practice a coin
 * created seconds ago. Without a bound, a heavy user's 60 remembered mints
 * would each cost a round trip, which is the unbounded cost this whole
 * function exists to avoid, aimed squarely at the people who use the site most.
 */
const MAX_HINT_READS = 12;

export type BoardBuckets = Record<BoardBucket, CoinView[]>;

/**
 * The whole board, from chain, in a bounded number of RPC calls.
 *
 * The ordering here is the point. Bucket and sort on the CURVE data — which
 * the scan already returned — then cap each column, and only THEN read
 * metadata, for the coins that will actually be rendered. Fetching names for
 * every coin first is what turns a launchpad with ten thousand coins into a
 * hundred extra round trips and several more megabytes for a page that shows
 * a hundred and fifty cards.
 *
 * `hints` are this browser's remembered mints. They are NOT discovery — the
 * scan is — but a coin created seconds ago may not be in the scan's snapshot
 * yet and its launcher should still see it, so any hint the scan did not
 * return is read individually (bounded) and pinned to the front of its column.
 *
 * Cost: 1 scan + at most `MAX_HINT_READS` single reads + 2 metadata batches,
 * whatever the launchpad's size.
 */
export async function fetchBoardFromChain(
  connection: Connection,
  opts: { perColumn?: number; hints?: string[] } = {},
): Promise<BoardBuckets> {
  const perColumn = opts.perColumn ?? BOARD_COLUMN_LIMIT;
  const curves = await fetchCurvesFromChain(connection);
  const out = { new: [], graduating: [], graduated: [] } as BoardBuckets;

  // Dedupe hints against EVERY scanned coin, not just the displayed ones —
  // otherwise capping the columns turns remembered coins back into reads.
  const scanned = new Set(curves.map((c) => c.mint.toBase58()));
  const missing = (opts.hints ?? [])
    .filter((m) => !scanned.has(m))
    .slice(0, MAX_HINT_READS);

  const blank: CoinMetadata = { name: "", symbol: "", uri: "" };
  const views = curves.map((c) => coinViewFromCurve(c.mint.toBase58(), c, blank));
  for (const view of views) out[boardBucket(view)].push(view);
  // Busiest first, so an empty new coin never sits above one that is trading.
  for (const key of Object.keys(out) as BoardBucket[]) {
    out[key].sort((a, b) => Number(BigInt(b.realSol) - BigInt(a.realSol)));
    out[key] = out[key].slice(0, perColumn);
  }

  // Hints join AFTER the cap, at the front: a coin you just launched has no
  // raise yet and would rank last, which is the one place ranking is wrong.
  if (missing.length > 0) {
    const extra = (
      await Promise.all(
        missing.map((m) => fetchCoinFromChain(connection, m).catch(() => null)),
      )
    ).filter((c): c is CoinView => c !== null);
    for (const coin of extra) out[boardBucket(coin)].unshift(coin);
  }

  const shown = (Object.keys(out) as BoardBucket[]).flatMap((k) => out[k]);
  if (shown.length === 0) return out;
  const metas = await fetchMetadataFor(
    connection,
    shown.map((c) => new PublicKey(c.mint)),
  );
  for (const view of shown) {
    const meta = metas.get(view.mint);
    if (meta && (meta.name || meta.symbol)) {
      view.name = meta.name;
      view.symbol = meta.symbol;
      view.uri = meta.uri;
    }
  }
  return out;
}

/**
 * Curve progress without the config account: the pump-classic sellable reserve
 * is the denominator, which every coin on this deployment shares. Complete or
 * migrated curves read 100%.
 */
function progressFromCurve(realToken: bigint, done: boolean): number {
  if (done) return 10_000;
  const INITIAL_REAL = 793_100_000_000_000n;
  if (realToken >= INITIAL_REAL) return 0;
  const sold = INITIAL_REAL - realToken;
  return Number((sold * 10_000n) / INITIAL_REAL);
}
