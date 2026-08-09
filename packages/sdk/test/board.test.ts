import { describe, expect, it } from "vitest";
import {
  GRADUATING_THRESHOLD_BPS,
  boardBucket,
  type BoardBucket,
} from "../src/launchpad/board";

const coin = (progressBps: number, complete = false, migrated = false) => ({
  progressBps,
  complete,
  migrated,
});

describe("boardBucket", () => {
  it("puts a migrated coin in graduated regardless of the other flags", () => {
    expect(boardBucket(coin(0, false, true))).toBe("graduated");
    expect(boardBucket(coin(10_000, true, true))).toBe("graduated");
  });

  it("treats complete-but-uncranked as about to graduate", () => {
    expect(boardBucket(coin(10_000, true, false))).toBe("graduating");
  });

  it("splits new from graduating at the threshold (inclusive)", () => {
    expect(boardBucket(coin(GRADUATING_THRESHOLD_BPS - 1))).toBe("new");
    expect(boardBucket(coin(GRADUATING_THRESHOLD_BPS))).toBe("graduating");
  });

  it("honors a custom threshold", () => {
    expect(boardBucket(coin(5000), 5000)).toBe("graduating");
    expect(boardBucket(coin(4999), 5000)).toBe("new");
  });

  it("assigns every coin to exactly one bucket", () => {
    const seen = new Set<BoardBucket>();
    for (const c of [coin(0), coin(9000), coin(0, true), coin(0, false, true)]) {
      seen.add(boardBucket(c));
    }
    expect([...seen].sort()).toEqual(["graduated", "graduating", "new"]);
  });
});
