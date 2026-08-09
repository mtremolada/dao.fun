/**
 * The board's chain-direct cost must not grow with the launchpad.
 *
 * The first version of this fetched metadata for EVERY coin before deciding
 * which few dozen to render, which is a hundred extra round trips and several
 * megabytes once a launchpad has ten thousand coins — to draw a page that
 * shows a hundred and fifty cards. The fix is ordering: bucket and rank on the
 * curve data the scan already returned, cap each column, and only then read
 * names for what will actually be drawn.
 *
 * That ordering is invisible in the rendered output — the board looks
 * identical either way — so it is exactly the kind of property that rots
 * silently. These tests assert the COST, not the appearance.
 */
import { describe, expect, it } from "vitest";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  BOARD_COLUMN_LIMIT,
  CURVE_ACCOUNT_LEN,
  fetchBoardFromChain,
} from "../lib/chain-coin";

const INITIAL_REAL = 793_100_000_000_000n;

function u64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

/** Curve account bytes, matching the on-chain layout by offset. */
function curve(opts: {
  mint: PublicKey;
  realSol: bigint;
  realToken: bigint;
  complete?: boolean;
  migrated?: boolean;
}): Buffer {
  const b = Buffer.concat([
    Buffer.alloc(8),
    opts.mint.toBuffer(),
    PublicKey.default.toBuffer(),
    u64(30_000_000_000n),
    u64(1_073_000_000_000_000n),
    u64(opts.realSol),
    u64(opts.realToken),
    Buffer.from([70, 0, 30, 0]),
    Buffer.from([opts.complete ? 1 : 0, opts.migrated ? 1 : 0]),
    PublicKey.default.toBuffer(),
    Buffer.from([255]),
  ]);
  expect(b.length).toBe(CURVE_ACCOUNT_LEN);
  return b;
}

/** A connection that counts calls and never talks to a network. */
function fakeConnection(count: number) {
  const calls = { gpa: 0, meta: 0, metaAccounts: 0 };
  // Distinct addresses without ed25519 keygen — nothing here ever signs, and
  // generating 50k real keypairs cost 19 seconds of every test run.
  const mints = Array.from({ length: count }, (_, i) => {
    const b = Buffer.alloc(32);
    b.writeUInt32LE(i + 1, 0);
    return new PublicKey(b);
  });
  const connection = {
    getProgramAccounts: async () => {
      calls.gpa++;
      return mints.map((mint, i) => ({
        pubkey: mint,
        account: {
          data: curve({
            mint,
            // Descending raise, so the ranking is checkable.
            realSol: BigInt(count - i) * 1_000_000n,
            realToken: INITIAL_REAL,
          }),
        },
      }));
    },
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      calls.meta++;
      calls.metaAccounts += keys.length;
      return keys.map(() => null); // no metadata: the coin must survive it
    },
  } as unknown as Connection;
  return { connection, calls, mints };
}

describe("board cost", () => {
  it("reads names only for the coins it will draw, not for every coin", async () => {
    const { connection, calls } = fakeConnection(5_000);
    const board = await fetchBoardFromChain(connection);

    expect(calls.gpa).toBe(1);
    // 5,000 coins, one column shown: the cap, not the launchpad, decides.
    expect(board.new).toHaveLength(BOARD_COLUMN_LIMIT);
    expect(calls.metaAccounts).toBe(BOARD_COLUMN_LIMIT);
    expect(calls.meta).toBe(1);
  });

  it("costs the same at ten coins and at fifty thousand", async () => {
    const small = fakeConnection(10);
    const huge = fakeConnection(50_000);
    await fetchBoardFromChain(small.connection);
    await fetchBoardFromChain(huge.connection);

    expect(huge.calls.gpa).toBe(small.calls.gpa);
    // Metadata batches are capped by the columns, so the big launchpad costs
    // at most the 100-account ceiling more — never 500x.
    expect(huge.calls.meta).toBeLessThanOrEqual(2);
    expect(huge.calls.metaAccounts).toBeLessThanOrEqual(3 * BOARD_COLUMN_LIMIT);
  });

  it("ranks by raise so a busy coin is never below an empty one", async () => {
    const { connection } = fakeConnection(200);
    const board = await fetchBoardFromChain(connection);
    const raises = board.new.map((c) => BigInt(c.realSol));
    for (let i = 1; i < raises.length; i++) {
      expect(raises[i - 1]! >= raises[i]!).toBe(true);
    }
  });

  it("keeps a coin whose metadata is missing — the curve is the truth", async () => {
    const { connection } = fakeConnection(3);
    const board = await fetchBoardFromChain(connection);
    expect(board.new).toHaveLength(3);
    // Present and tradeable, under the view builder's readable fallback —
    // an empty metadata read must not overwrite that with a blank card.
    expect(board.new[0]!.name).toBe("Unknown coin");
    expect(board.new[0]!.symbol).toBe("???");
    expect(board.new[0]!.mint).toBeTruthy();
  });

  it("bounds remembered mints too — capping columns must not resurrect reads", async () => {
    // 5,000 coins on chain, and this browser remembers 60 of its own that are
    // NOT in the scan. Deduping against the DISPLAYED coins instead of every
    // scanned coin would fire one read per remembered mint — unbounded cost
    // aimed at the people who use the site most.
    const { connection, calls } = fakeConnection(5_000);
    const strangers = Array.from({ length: 60 }, (_, i) => {
      const b = Buffer.alloc(32);
      b.writeUInt32LE(900_000 + i, 0);
      return new PublicKey(b).toBase58();
    });
    let singleReads = 0;
    (connection as unknown as { getAccountInfo: unknown }).getAccountInfo = async () => {
      singleReads++;
      return null; // the hint does not resolve; the board must not care
    };

    const board = await fetchBoardFromChain(connection, { hints: strangers });
    expect(calls.gpa).toBe(1);
    expect(singleReads).toBeLessThanOrEqual(12);
    expect(board.new).toHaveLength(BOARD_COLUMN_LIMIT);
  });

  it("a remembered mint ALREADY in the scan costs no extra read", async () => {
    const { connection, mints } = fakeConnection(200);
    let singleReads = 0;
    (connection as unknown as { getAccountInfo: unknown }).getAccountInfo = async () => {
      singleReads++;
      return null;
    };
    await fetchBoardFromChain(connection, {
      hints: mints.slice(0, 30).map((m) => m.toBase58()),
    });
    expect(singleReads).toBe(0);
  });

  it("does no metadata round trip at all when there are no coins", async () => {
    const { connection, calls } = fakeConnection(0);
    const board = await fetchBoardFromChain(connection);
    expect(board.new).toHaveLength(0);
    expect(calls.meta).toBe(0);
  });
});
