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
import { curvePda, decodeCurve } from "@daofun/sdk/launchpad";
import type { CoinView } from "./launchpad-api";
import { launchpadProgramId } from "./cluster";

const LOCAL_KEY = "daofun:local-coins";

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

/** Metaplex metadata PDA → { name, symbol, uri }, parsed from the raw account. */
async function readMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<{ name: string; symbol: string; uri: string }> {
  const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()],
    METAPLEX,
  );
  const info = await connection.getAccountInfo(pda);
  if (!info) return { name: "", symbol: "", uri: "" };
  // key(1) + updateAuthority(32) + mint(32), then borsh strings.
  const d = Buffer.from(info.data);
  let o = 1 + 32 + 32;
  const str = () => {
    const len = d.readUInt32LE(o);
    o += 4;
    const s = d.subarray(o, o + len).toString("utf8").replace(/\0+$/, "");
    o += len;
    return s;
  };
  return { name: str(), symbol: str(), uri: str() };
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
  const meta = await readMetadata(connection, mintKey).catch(() => ({
    name: "",
    symbol: "",
    uri: "",
  }));

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
