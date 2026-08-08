/**
 * Launchpad index storage — coins, trades, and the poll cursor — on Node 22's
 * built-in node:sqlite (the SqliteArtifactStore pattern; no native deps).
 *
 * Trades are keyed by (signature, ix_index) so a re-scan after a restart or a
 * devnet rollback upserts idempotently instead of double-counting. Candles are
 * aggregated at read time — at devnet volume a bucketed query is cheaper than
 * a second table to keep in sync.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { aggregateCandles, type Candle } from "@daofun/sdk/launchpad";

export interface CoinRow {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  creator: string;
  virtualSol: string;
  virtualToken: string;
  realSol: string;
  realToken: string;
  complete: number;
  migrated: number;
  poolState: string | null;
  createdSlot: number;
  createdBlockTime: number | null;
  lastSlot: number;
}

export interface TradeRow {
  signature: string;
  ixIndex: number;
  mint: string;
  trader: string;
  isBuy: number;
  tokenAmount: string;
  solAmount: string;
  virtualSol: string;
  virtualToken: string;
  realSol: string;
  realToken: string;
  slot: number;
  blockTime: number | null;
}

export interface Cursor {
  lastSignature: string | null;
  lastSlot: number;
}

export class SqliteLaunchpadStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coins (
        mint TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        uri TEXT NOT NULL,
        creator TEXT NOT NULL,
        virtual_sol TEXT NOT NULL,
        virtual_token TEXT NOT NULL,
        real_sol TEXT NOT NULL,
        real_token TEXT NOT NULL,
        complete INTEGER NOT NULL DEFAULT 0,
        migrated INTEGER NOT NULL DEFAULT 0,
        pool_state TEXT,
        created_slot INTEGER NOT NULL,
        created_block_time INTEGER,
        last_slot INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        signature TEXT NOT NULL,
        ix_index INTEGER NOT NULL,
        mint TEXT NOT NULL,
        trader TEXT NOT NULL,
        is_buy INTEGER NOT NULL,
        token_amount TEXT NOT NULL,
        sol_amount TEXT NOT NULL,
        virtual_sol TEXT NOT NULL,
        virtual_token TEXT NOT NULL,
        real_sol TEXT NOT NULL,
        real_token TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (signature, ix_index)
      );
      CREATE INDEX IF NOT EXISTS trades_mint_time ON trades (mint, block_time);
      CREATE TABLE IF NOT EXISTS cursor (
        id INTEGER PRIMARY KEY CHECK (id = 0),
        last_signature TEXT,
        last_slot INTEGER NOT NULL DEFAULT 0
      );
      INSERT OR IGNORE INTO cursor (id, last_signature, last_slot) VALUES (0, NULL, 0);
    `);
  }

  static fromEnv(store: string): SqliteLaunchpadStore {
    if (!store.startsWith("sqlite:")) {
      throw new Error(`unsupported LAUNCHPAD_STORE "${store}" — expected sqlite:<path>`);
    }
    return new SqliteLaunchpadStore(store.slice("sqlite:".length));
  }

  upsertCoin(c: CoinRow): void {
    this.db
      .prepare(
        `INSERT INTO coins (mint, name, symbol, uri, creator, virtual_sol,
           virtual_token, real_sol, real_token, complete, migrated, pool_state,
           created_slot, created_block_time, last_slot)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(mint) DO UPDATE SET
           name=excluded.name, symbol=excluded.symbol, uri=excluded.uri,
           creator=excluded.creator, created_slot=coins.created_slot,
           created_block_time=coins.created_block_time`,
      )
      .run(
        c.mint, c.name, c.symbol, c.uri, c.creator, c.virtualSol, c.virtualToken,
        c.realSol, c.realToken, c.complete, c.migrated, c.poolState,
        c.createdSlot, c.createdBlockTime, c.lastSlot,
      );
  }

  /**
   * Roll the cached reserves/flags forward, never backward in slot. Any
   * reserve left undefined is kept (COALESCE) — a completion event carries a
   * new raise but not new virtual reserves, and must not zero them. Flags only
   * ratchet up (MAX), matching the on-chain one-way transitions.
   */
  updateCoinState(mint: string, s: {
    virtualSol?: bigint; virtualToken?: bigint; realSol?: bigint; realToken?: bigint;
    complete?: boolean; migrated?: boolean; poolState?: string | null; slot: number;
  }): void {
    const orNull = (v?: bigint) => (v === undefined ? null : v.toString());
    this.db
      .prepare(
        `UPDATE coins SET
           virtual_sol=COALESCE(?, virtual_sol),
           virtual_token=COALESCE(?, virtual_token),
           real_sol=COALESCE(?, real_sol),
           real_token=COALESCE(?, real_token),
           complete=MAX(complete, ?), migrated=MAX(migrated, ?),
           pool_state=COALESCE(?, pool_state), last_slot=MAX(last_slot, ?)
         WHERE mint=? AND ? >= last_slot`,
      )
      .run(
        orNull(s.virtualSol), orNull(s.virtualToken), orNull(s.realSol),
        orNull(s.realToken), s.complete ? 1 : 0, s.migrated ? 1 : 0,
        s.poolState ?? null, s.slot, mint, s.slot,
      );
  }

  insertTrade(t: TradeRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO trades (signature, ix_index, mint, trader, is_buy,
           token_amount, sol_amount, virtual_sol, virtual_token, real_sol,
           real_token, slot, block_time)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        t.signature, t.ixIndex, t.mint, t.trader, t.isBuy, t.tokenAmount,
        t.solAmount, t.virtualSol, t.virtualToken, t.realSol, t.realToken,
        t.slot, t.blockTime,
      );
  }

  getCoin(mint: string): CoinRow | undefined {
    return this.mapCoin(
      this.db.prepare(`SELECT * FROM coins WHERE mint=?`).get(mint) as Record<string, unknown> | undefined,
    );
  }

  /** Board query. `filter`: new (default), graduating (>= threshold, not migrated), graduated. */
  listCoins(opts: {
    filter?: "new" | "graduating" | "graduated";
    limit?: number;
    progressThresholdBps?: number;
  } = {}): CoinRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    let where = "1=1";
    if (opts.filter === "graduated") where = "migrated = 1";
    else if (opts.filter === "graduating") where = "migrated = 0 AND complete = 0";
    else where = "migrated = 0";
    const rows = this.db
      .prepare(`SELECT * FROM coins WHERE ${where} ORDER BY created_slot DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapCoin(r)!).filter(Boolean);
  }

  listTrades(mint: string, limit = 100): TradeRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE mint=? ORDER BY slot DESC, ix_index DESC LIMIT ?`)
      .all(mint, Math.min(Math.max(limit, 1), 500)) as Record<string, unknown>[];
    return rows.map((r) => this.mapTrade(r));
  }

  /**
   * OHLCV candles from the trade stream — aggregation shared with the app's
   * chain-direct fallback via @daofun/sdk/launchpad (one implementation, so
   * chart and API can never disagree about a bucket).
   */
  candles(mint: string, resolutionSeconds: number, limit = 500): Candle[] {
    const rows = this.db
      .prepare(
        `SELECT block_time, virtual_sol, virtual_token, sol_amount, slot, ix_index
         FROM trades WHERE mint=? AND block_time IS NOT NULL
         ORDER BY slot ASC, ix_index ASC`,
      )
      .all(mint) as { block_time: number; virtual_sol: string; virtual_token: string; sol_amount: string }[];
    return aggregateCandles(
      rows.map((r) => ({
        blockTime: r.block_time,
        virtualSol: BigInt(r.virtual_sol),
        virtualToken: BigInt(r.virtual_token),
        solAmount: BigInt(r.sol_amount),
      })),
      resolutionSeconds,
      limit,
    );
  }

  getCursor(): Cursor {
    const row = this.db.prepare(`SELECT last_signature, last_slot FROM cursor WHERE id=0`).get() as
      | { last_signature: string | null; last_slot: number }
      | undefined;
    return { lastSignature: row?.last_signature ?? null, lastSlot: row?.last_slot ?? 0 };
  }

  setCursor(c: Cursor): void {
    this.db
      .prepare(`UPDATE cursor SET last_signature=?, last_slot=? WHERE id=0`)
      .run(c.lastSignature, c.lastSlot);
  }

  /** Newest indexed slot, for the /health lag gauge. */
  maxSlot(): number {
    const row = this.db.prepare(`SELECT MAX(last_slot) AS s FROM coins`).get() as { s: number | null };
    return row?.s ?? 0;
  }

  close(): void {
    this.db.close();
  }

  private mapCoin(r: Record<string, unknown> | undefined): CoinRow | undefined {
    if (!r) return undefined;
    return {
      mint: r.mint as string,
      name: r.name as string,
      symbol: r.symbol as string,
      uri: r.uri as string,
      creator: r.creator as string,
      virtualSol: r.virtual_sol as string,
      virtualToken: r.virtual_token as string,
      realSol: r.real_sol as string,
      realToken: r.real_token as string,
      complete: r.complete as number,
      migrated: r.migrated as number,
      poolState: (r.pool_state as string | null) ?? null,
      createdSlot: r.created_slot as number,
      createdBlockTime: (r.created_block_time as number | null) ?? null,
      lastSlot: r.last_slot as number,
    };
  }

  private mapTrade(r: Record<string, unknown>): TradeRow {
    return {
      signature: r.signature as string,
      ixIndex: r.ix_index as number,
      mint: r.mint as string,
      trader: r.trader as string,
      isBuy: r.is_buy as number,
      tokenAmount: r.token_amount as string,
      solAmount: r.sol_amount as string,
      virtualSol: r.virtual_sol as string,
      virtualToken: r.virtual_token as string,
      realSol: r.real_sol as string,
      realToken: r.real_token as string,
      slot: r.slot as number,
      blockTime: (r.block_time as number | null) ?? null,
    };
  }
}
