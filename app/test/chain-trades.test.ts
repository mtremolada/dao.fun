/**
 * Chain-direct trade history: decode inner-instruction TradeEvents the same
 * way the wire carries them (EVENT_IX_TAG || discriminator || borsh), merge
 * incrementally, and derive candles. The fetch orchestration runs against a
 * fake Connection.
 */
import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { EVENT_IX_TAG, eventDiscriminator } from "@daofun/sdk/launchpad";
import { launchpadProgramId } from "../lib/cluster";
import {
  candlesFromTrades,
  fetchTradeHistory,
  mergeTrades,
  tradesFromTransaction,
  type TxLike,
} from "../lib/chain-trades";
import type { TradeView } from "../lib/launchpad-api";

const MINT = Keypair.generate().publicKey;
const TRADER = Keypair.generate().publicKey;
const PROGRAM = launchpadProgramId();

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};

function tradeEventData(over: { isBuy?: boolean; solAmount?: bigint; virtualSol?: bigint } = {}): string {
  return bs58.encode(
    Buffer.concat([
      EVENT_IX_TAG,
      eventDiscriminator("TradeEvent"),
      MINT.toBuffer(),
      TRADER.toBuffer(),
      Buffer.from([over.isBuy === false ? 0 : 1]),
      u64(1_000_000_000n), // tokenAmount
      u64(over.solAmount ?? 50_000_000n),
      u64(350_000n), // protocolFee
      u64(150_000n), // creatorFee
      u64(over.virtualSol ?? 30_050_000_000n),
      u64(1_072_000_000_000_000n),
      u64(49_500_000n),
      u64(792_100_000_000_000n),
    ]),
  );
}

function txWith(data: string[], opts: { slot?: number; blockTime?: number | null; err?: unknown } = {}): TxLike {
  return {
    slot: opts.slot ?? 100,
    blockTime: opts.blockTime === undefined ? 1_700_000_000 : opts.blockTime,
    meta: {
      err: opts.err ?? null,
      innerInstructions: [
        { index: 0, instructions: data.map((d) => ({ programIdIndex: 1, data: d })) },
      ],
    },
    transaction: { message: { accountKeys: [TRADER, PROGRAM] } },
  };
}

describe("tradesFromTransaction", () => {
  it("decodes a TradeEvent inner instruction into a TradeView", () => {
    const [t] = tradesFromTransaction(txWith([tradeEventData()]), "sig1", MINT.toBase58());
    expect(t).toMatchObject({
      signature: "sig1",
      mint: MINT.toBase58(),
      trader: TRADER.toBase58(),
      isBuy: true,
      tokenAmount: "1000000000",
      solAmount: "50000000",
      virtualSol: "30050000000",
      slot: 100,
      blockTime: 1_700_000_000,
    });
  });

  it("skips failed transactions, foreign programs, and other mints", () => {
    expect(tradesFromTransaction(txWith([tradeEventData()], { err: { some: "err" } }), "s", MINT.toBase58())).toHaveLength(0);
    const foreign = txWith([tradeEventData()]);
    foreign.transaction.message.accountKeys = [TRADER, TRADER]; // program key gone
    expect(tradesFromTransaction(foreign, "s", MINT.toBase58())).toHaveLength(0);
    expect(tradesFromTransaction(txWith([tradeEventData()]), "s", TRADER.toBase58())).toHaveLength(0);
  });

  it("tolerates garbage data without throwing", () => {
    expect(tradesFromTransaction(txWith(["!!not-base58!!", bs58.encode(Buffer.from("junk"))]), "s", MINT.toBase58())).toHaveLength(0);
  });
});

describe("mergeTrades", () => {
  const tv = (signature: string, slot: number): TradeView => ({
    signature, mint: "m", trader: "t", isBuy: true, tokenAmount: "1", solAmount: "1",
    virtualSol: "1", virtualToken: "1", slot, blockTime: slot,
  });

  it("dedupes by identity, orders newest-first, and caps", () => {
    const merged = mergeTrades([tv("b", 2), tv("a", 1)], [tv("a", 1), tv("c", 3)], 2);
    expect(merged.map((t) => t.signature)).toEqual(["c", "b"]);
  });
});

describe("candlesFromTrades", () => {
  it("converts newest-first trades into chronological candles, skipping null blockTime", () => {
    const tv = (slot: number, blockTime: number | null, vSol: string): TradeView => ({
      signature: `s${slot}`, mint: "m", trader: "t", isBuy: true, tokenAmount: "1",
      solAmount: "1000000000", virtualSol: vSol, virtualToken: "1000000000000000",
      slot, blockTime,
    });
    const candles = candlesFromTrades(
      [tv(3, 120, "40000000000"), tv(2, null, "99000000000"), tv(1, 60, "30000000000")],
      60,
    );
    expect(candles.map((c) => c.time)).toEqual([60, 120]);
    expect(candles[0]!.close).toBeCloseTo(30 / 1_000_000_000, 15);
    expect(candles[1]!.close).toBeCloseTo(40 / 1_000_000_000, 15);
  });
});

describe("fetchTradeHistory", () => {
  it("walks signatures → transactions → decoded trades against a fake Connection", async () => {
    const connection = {
      getSignaturesForAddress: async () => [
        { signature: "sig2", err: null },
        { signature: "sigFail", err: { boom: 1 } },
        { signature: "sig1", err: null },
      ],
      getTransactions: async (sigs: string[]) =>
        sigs.map((s) =>
          txWith([tradeEventData({ solAmount: s === "sig2" ? 75_000_000n : 50_000_000n })], {
            slot: s === "sig2" ? 200 : 100,
          }),
        ),
    } as unknown as Connection;

    const trades = await fetchTradeHistory(connection, MINT.toBase58());
    expect(trades.map((t) => t.signature)).toEqual(["sig2", "sig1"]);
    expect(trades[0]!.solAmount).toBe("75000000");
  });
});
