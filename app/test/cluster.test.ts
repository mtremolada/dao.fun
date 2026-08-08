import { afterEach, describe, expect, it } from "vitest";
import { chainId, cluster, explorerTx, isDevnet } from "../lib/cluster";

const orig = process.env.NEXT_PUBLIC_CLUSTER;
afterEach(() => {
  if (orig === undefined) delete process.env.NEXT_PUBLIC_CLUSTER;
  else process.env.NEXT_PUBLIC_CLUSTER = orig;
});

describe("cluster", () => {
  it("defaults to devnet and builds ?cluster=devnet explorer links", () => {
    delete process.env.NEXT_PUBLIC_CLUSTER;
    expect(cluster()).toBe("devnet");
    expect(isDevnet()).toBe(true);
    expect(chainId()).toBe("solana:devnet");
    expect(explorerTx("abc")).toContain("?cluster=devnet");
  });

  it("honors mainnet with no explorer suffix", () => {
    process.env.NEXT_PUBLIC_CLUSTER = "mainnet";
    expect(cluster()).toBe("mainnet");
    expect(isDevnet()).toBe(false);
    expect(chainId()).toBe("solana:mainnet");
    expect(explorerTx("abc")).toBe("https://explorer.solana.com/tx/abc");
  });
});
