import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHPAD_PROGRAM_ID } from "@daofun/sdk/launchpad";
import {
  chainId,
  cluster,
  explorerTx,
  isDevnet,
  launchpadProgramId,
} from "../lib/cluster";

const orig = process.env.NEXT_PUBLIC_CLUSTER;
const origProgram = process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID;
afterEach(() => {
  if (orig === undefined) delete process.env.NEXT_PUBLIC_CLUSTER;
  else process.env.NEXT_PUBLIC_CLUSTER = orig;
  if (origProgram === undefined) delete process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID;
  else process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID = origProgram;
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

describe("launchpad program id", () => {
  /**
   * This file used to keep its own literal copy of the id. After the first
   * real deploy the SDK's copy was updated and this one was not, so every run
   * without the env var pointed the app at a program that does not exist and
   * every read came back empty — invisible, because the Pages workflow always
   * sets the variable. One constant, asserted to be the SAME constant.
   */
  it("falls back to the SDK's id, not a copy of it", () => {
    delete process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID;
    expect(launchpadProgramId().toBase58()).toBe(LAUNCHPAD_PROGRAM_ID.toBase58());
  });

  it("still honors an explicit override", () => {
    process.env.NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID =
      "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr";
    expect(launchpadProgramId().toBase58()).toBe(
      "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr",
    );
  });
});
