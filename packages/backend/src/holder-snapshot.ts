/**
 * Holder-snapshot sources — spec 6.8 `distribute`: "backend snapshots
 * holders at slot (RPC/DAS)". The share math itself is in the sdk
 * (proRataShares); this module only fetches WHO holds WHAT at a slot.
 *
 * - RpcHolderSnapshot: getProgramAccounts on the token program, memcmp on
 *   the mint at offset 0. Token-2022 accounts vary in size (extensions),
 *   so there is no dataSize filter; a 72-byte dataSlice (mint|owner|amount)
 *   keeps responses small regardless. `withContext` pins the slot.
 * - DasHolderSnapshot: Helius DAS getTokenAccounts with cursor pagination —
 *   optional and feature-flagged per the env spec (HELIUS_API_KEY);
 *   without it everything works on the public RPC default.
 *
 * Trust note (12.3 applies): the snapshot is an OFF-CHAIN input. What the
 * DAO actually votes on is the merkle root pinned in the proposal (INV-9);
 * voters verify the published share list against the root, not the backend.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { HolderBalance } from "@daofun/sdk";

export interface HolderSnapshot {
  /** Slot the snapshot was read at (best-effort for DAS — see source). */
  slot: number;
  holders: HolderBalance[];
}

export interface HolderSnapshotSource {
  snapshotHolders(mint: PublicKey): Promise<HolderSnapshot>;
}

/** mint(32) | owner(32) | amount u64(8) — the base layout prefix shared by
 *  SPL Token and Token-2022 accounts. */
const SLICE_LEN = 72;

export class RpcHolderSnapshot implements HolderSnapshotSource {
  constructor(
    private readonly connection: Connection,
    /** v2 launches mint Token-2022 (D-004); pass TOKEN_PROGRAM_ID for legacy. */
    private readonly tokenProgramId: PublicKey = TOKEN_2022_PROGRAM_ID,
  ) {}

  async snapshotHolders(mint: PublicKey): Promise<HolderSnapshot> {
    let res;
    try {
      res = await this.connection.getProgramAccounts(this.tokenProgramId, {
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
        dataSlice: { offset: 0, length: SLICE_LEN },
        withContext: true,
      });
    } catch (e) {
      // The PUBLIC mainnet RPC excludes the token programs from secondary
      // indexes (-32010, verified live — D-026); free tiers commonly gate
      // the method too. The env spec promises zero-signup defaults work,
      // so degrade to the top-20 largest-accounts read — and refuse loudly
      // when it might be truncated.
      if (
        /secondary indexes|not available|unavailable|upgrade to paid/i.test(
          (e as Error).message,
        )
      ) {
        return this.snapshotViaLargestAccounts(mint);
      }
      throw e;
    }
    const holders: HolderBalance[] = res.value.map(({ pubkey, account }) => {
      const data = account.data;
      if (data.length < SLICE_LEN) {
        throw new Error(
          `holder snapshot: short data slice for ${pubkey.toBase58()} (${data.length} bytes)`,
        );
      }
      return {
        owner: new PublicKey(data.subarray(32, 64)),
        amount: data.readBigUInt64LE(64),
      };
    });
    return { slot: res.context.slot, holders };
  }

  /**
   * The zero-signup fallback: top-20 token accounts + owner reads. Exact
   * for <= 19 accounts, REFUSES at the cap (a truncated holder set must
   * never silently feed a distribution). Public because operators on the
   * default RPC may want it directly (gPA there is index-excluded AND
   * per-method rate-limited, so the auto-fallback can be slow to engage).
   */
  async snapshotViaLargestAccounts(mint: PublicKey): Promise<HolderSnapshot> {
    const largest = await this.connection.getTokenLargestAccounts(
      mint,
      "confirmed",
    );
    if (largest.value.length >= 20) {
      throw new Error(
        "holder snapshot: getTokenLargestAccounts hit the top-20 cap — the holder set may be TRUNCATED; configure an indexed RPC or Helius DAS (D-026)",
      );
    }
    const addresses = largest.value.map((v) => v.address);
    const infos = await this.connection.getMultipleAccountsInfo(addresses);
    const holders: HolderBalance[] = largest.value.map((pair, i) => {
      const info = infos[i];
      if (!info || info.data.length < 64) {
        throw new Error(
          `holder snapshot: cannot read owner of ${pair.address.toBase58()}`,
        );
      }
      return {
        owner: new PublicKey(info.data.subarray(32, 64)),
        amount: BigInt(pair.amount),
      };
    });
    return { slot: largest.context.slot, holders };
  }
}

export interface DasHolderSnapshotConfig {
  /** Full DAS RPC url including the api key (e.g. Helius). */
  url: string;
  fetchImpl?: typeof fetch;
  pageLimit?: number;
}

/** DAS amounts arrive as JSON numbers or strings; refuse precision loss. */
function dasAmount(v: unknown): bigint {
  if (typeof v === "string") return BigInt(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) {
      throw new Error(
        `holder snapshot: DAS amount ${v} exceeds the safe integer range — use the RPC source (INV-6)`,
      );
    }
    return BigInt(v);
  }
  throw new Error(`holder snapshot: unexpected DAS amount ${String(v)}`);
}

export class DasHolderSnapshot implements HolderSnapshotSource {
  private readonly fetchImpl: typeof fetch;
  private readonly pageLimit: number;

  constructor(private readonly cfg: DasHolderSnapshotConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.pageLimit = cfg.pageLimit ?? 1000;
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const res = await this.fetchImpl(this.cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "snapshot", method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error || body.result === undefined) {
      throw new Error(
        `holder snapshot: DAS ${method} failed: ${body.error?.message ?? "no result"}`,
      );
    }
    return body.result;
  }

  async snapshotHolders(mint: PublicKey): Promise<HolderSnapshot> {
    // DAS indexes lag the tip slightly; the slot recorded here is the
    // endpoint's current slot — an upper bound on the snapshot's age.
    const slot = await this.rpc<number>("getSlot", [{ commitment: "confirmed" }]);
    const holders: HolderBalance[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.rpc<{
        token_accounts?: { owner: string; amount: unknown }[];
        cursor?: string;
      }>("getTokenAccounts", {
        mint: mint.toBase58(),
        limit: this.pageLimit,
        ...(cursor ? { cursor } : {}),
      });
      for (const ta of page.token_accounts ?? []) {
        holders.push({ owner: new PublicKey(ta.owner), amount: dasAmount(ta.amount) });
      }
      cursor =
        page.cursor && (page.token_accounts?.length ?? 0) > 0
          ? page.cursor
          : undefined;
    } while (cursor);
    return { slot, holders };
  }
}

/** Env-spec wiring: Helius when configured, public RPC otherwise. */
export function makeHolderSnapshotSource(opts: {
  connection: Connection;
  heliusUrl?: string;
  tokenProgramId?: PublicKey;
}): HolderSnapshotSource {
  if (opts.heliusUrl) {
    return new DasHolderSnapshot({ url: opts.heliusUrl });
  }
  return new RpcHolderSnapshot(opts.connection, opts.tokenProgramId);
}
