/**
 * Profile reads — everything a launcher needs about their own coins, from
 * chain alone (no indexer).
 *
 * Launches are found with getProgramAccounts filtered on the BondingCurve's
 * `creator` field. The filter is byte-exact — discriminator(8) + mint(32)
 * puts creator at offset 40 — and a dataSize filter keeps the scan to curve
 * accounts, so a config or vault account can never be mistaken for a coin.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { creatorVaultPda, decodeCurve } from "@daofun/sdk/launchpad";
import {
  coinViewFromCurve,
  metadataPdaFor,
  parseMetadata,
  type CoinMetadata,
} from "./chain-coin";
import type { CoinView } from "./launchpad-api";
import { launchpadProgramId } from "./cluster";

/**
 * BondingCurve layout: 8 disc + mint 32 + creator 32 + 4×u64 + 2×u16 +
 * complete + migrated + pool 32 + bump 1 = 143 bytes.
 *
 * The size filter is not an optimization, it is CORRECTNESS: the Config
 * account (277 B) stores its fee recipient at offset 40 too, so a creator
 * who is also the fee recipient would otherwise match the memcmp and be
 * decoded as one of their own coins. Measured against the deployed program.
 */
export const CURVE_ACCOUNT_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
export const CURVE_CREATOR_OFFSET = 8 + 32;

/**
 * What `collect_creator_fee` would actually pay out: the vault's balance
 * less the rent floor it must retain (the program computes exactly this and
 * refuses a zero payout, so the UI must not promise the floor).
 */
export function claimableFromVault(vaultLamports: number, rentFloorLamports: number): bigint {
  const claimable = BigInt(Math.max(0, Math.floor(vaultLamports))) - BigInt(Math.max(0, Math.floor(rentFloorLamports)));
  return claimable > 0n ? claimable : 0n;
}

/** Newest first — created_slot is not on the account, so sort by progress then name. */
function sortLaunches(coins: CoinView[]): CoinView[] {
  return [...coins].sort((a, b) => {
    if (a.migrated !== b.migrated) return a.migrated ? 1 : -1;
    if (b.progressBps !== a.progressBps) return b.progressBps - a.progressBps;
    return a.name.localeCompare(b.name);
  });
}

/** Every coin this wallet created, read straight from the program's accounts. */
export async function fetchLaunchesByCreator(
  connection: Connection,
  creator: string,
): Promise<CoinView[]> {
  let creatorKey: PublicKey;
  try {
    creatorKey = new PublicKey(creator);
  } catch {
    return [];
  }
  const programId = launchpadProgramId();
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { dataSize: CURVE_ACCOUNT_LEN },
      { memcmp: { offset: CURVE_CREATOR_OFFSET, bytes: creatorKey.toBase58() } },
    ],
  });
  if (accounts.length === 0) return [];

  const curves = accounts.map((a) => decodeCurve(a.account.data));
  // One batched read for every name/symbol rather than a call per coin.
  const metas = await connection
    .getMultipleAccountsInfo(curves.map((c) => metadataPdaFor(c.mint)))
    .catch(() => curves.map(() => null));
  return sortLaunches(
    curves.map((c, i) =>
      coinViewFromCurve(
        c.mint.toBase58(),
        c,
        parseMetadata(metas[i]?.data) as CoinMetadata,
      ),
    ),
  );
}

/**
 * Creator fees waiting to be claimed. ONE vault serves ALL of a wallet's
 * coins (seeds are ["creator-vault", creator]), so this is a single figure
 * across every launch — not a per-coin balance.
 */
export async function fetchClaimableCreatorFees(
  connection: Connection,
  creator: string,
): Promise<bigint> {
  let creatorKey: PublicKey;
  try {
    creatorKey = new PublicKey(creator);
  } catch {
    return 0n;
  }
  const vault = creatorVaultPda(creatorKey, launchpadProgramId());
  const [lamports, rentFloor] = await Promise.all([
    connection.getBalance(vault),
    connection.getMinimumBalanceForRentExemption(0),
  ]);
  return claimableFromVault(lamports, rentFloor);
}
