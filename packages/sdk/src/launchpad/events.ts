/**
 * Event codec for the indexer. The program emits events via anchor's
 * `emit_cpi!`, which writes them as a self-CPI whose instruction data is:
 *
 *     EVENT_IX_TAG (8) || eventDiscriminator (8) || borsh(event)
 *
 * The indexer walks a transaction's inner instructions, finds the ones whose
 * programId is ours and whose data starts with EVENT_IX_TAG, and decodes
 * them here. Logs are deliberately NOT the source: the runtime may truncate
 * them, inner-instruction data it never does.
 *
 * Unknown discriminators return null rather than throwing, so a future event
 * added in a program upgrade cannot crash an indexer built before it (the
 * tolerant-indexer-first upgrade rule).
 */
import { PublicKey } from "@solana/web3.js";
import { EVENT_IX_TAG, eventDiscriminator } from "./constants";

export type LaunchpadEvent =
  | ({ kind: "create" } & CreateEvent)
  | ({ kind: "trade" } & TradeEvent)
  | ({ kind: "complete" } & CompleteEvent)
  | ({ kind: "migrate" } & MigrateEvent);

export interface CreateEvent {
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  virtualSol: bigint;
  virtualToken: bigint;
  realToken: bigint;
  tokenTotalSupply: bigint;
}

export interface TradeEvent {
  mint: PublicKey;
  user: PublicKey;
  isBuy: boolean;
  tokenAmount: bigint;
  solAmount: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
}

export interface CompleteEvent {
  mint: PublicKey;
  raisedLamports: bigint;
  reservedTokens: bigint;
}

export interface MigrateEvent {
  mint: PublicKey;
  poolState: PublicKey;
  poolSol: bigint;
  poolTokens: bigint;
  lpBurned: bigint;
  createPoolFee: bigint;
  graduationFee: bigint;
}

const DISC = {
  create: eventDiscriminator("CreateEvent"),
  trade: eventDiscriminator("TradeEvent"),
  complete: eventDiscriminator("CompleteEvent"),
  migrate: eventDiscriminator("MigrateEvent"),
};

class Reader {
  private o = 0;
  constructor(private readonly d: Buffer) {}
  pubkey(): PublicKey {
    const k = new PublicKey(this.d.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
  u64(): bigint {
    const v = this.d.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  bool(): boolean {
    return this.d[this.o++] === 1;
  }
  string(): string {
    const len = this.d.readUInt32LE(this.o);
    this.o += 4;
    const s = this.d.subarray(this.o, this.o + len).toString("utf8");
    this.o += len;
    return s;
  }
}

/**
 * Decode one inner-instruction data blob. Returns null when the data is not
 * one of our events (wrong tag, or an unknown discriminator).
 */
export function decodeLaunchpadEvent(data: Buffer | Uint8Array): LaunchpadEvent | null {
  const d = Buffer.from(data);
  if (d.length < 16 || !d.subarray(0, 8).equals(EVENT_IX_TAG)) return null;
  const disc = d.subarray(8, 16);
  const r = new Reader(d.subarray(16));
  if (disc.equals(DISC.create)) {
    return {
      kind: "create",
      mint: r.pubkey(),
      creator: r.pubkey(),
      name: r.string(),
      symbol: r.string(),
      uri: r.string(),
      virtualSol: r.u64(),
      virtualToken: r.u64(),
      realToken: r.u64(),
      tokenTotalSupply: r.u64(),
    };
  }
  if (disc.equals(DISC.trade)) {
    return {
      kind: "trade",
      mint: r.pubkey(),
      user: r.pubkey(),
      isBuy: r.bool(),
      tokenAmount: r.u64(),
      solAmount: r.u64(),
      protocolFee: r.u64(),
      creatorFee: r.u64(),
      virtualSol: r.u64(),
      virtualToken: r.u64(),
      realSol: r.u64(),
      realToken: r.u64(),
    };
  }
  if (disc.equals(DISC.complete)) {
    return {
      kind: "complete",
      mint: r.pubkey(),
      raisedLamports: r.u64(),
      reservedTokens: r.u64(),
    };
  }
  if (disc.equals(DISC.migrate)) {
    return {
      kind: "migrate",
      mint: r.pubkey(),
      poolState: r.pubkey(),
      poolSol: r.u64(),
      poolTokens: r.u64(),
      lpBurned: r.u64(),
      createPoolFee: r.u64(),
      graduationFee: r.u64(),
    };
  }
  return null;
}
