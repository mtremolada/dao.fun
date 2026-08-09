/**
 * Which system answered a read, and whether that is news.
 *
 * The property under test is a COST property, invisible in the rendered
 * output: with an indexer configured, a read must not touch the chain unless
 * the indexer failed. Getting this wrong looks identical on screen and shows
 * up only as an RPC bill that scales with viewers.
 */
import { describe, expect, it } from "vitest";
import { readPreferApi } from "../lib/read-path";

describe("readPreferApi", () => {
  it("does not touch the chain at all when the API answers", async () => {
    let chainReads = 0;
    const out = await readPreferApi({
      apiConfigured: true,
      fromApi: async () => "from-api",
      fromChain: async () => {
        chainReads++;
        return "from-chain";
      },
    });
    expect(out).toEqual({ value: "from-api", source: "api", degraded: false });
    expect(chainReads).toBe(0);
  });

  it("falls back to the chain when the API fails, and SAYS it degraded", async () => {
    const errors: unknown[] = [];
    const out = await readPreferApi({
      apiConfigured: true,
      fromApi: async () => {
        throw new Error("502");
      },
      fromChain: async () => "from-chain",
      onFallback: (e) => errors.push(e),
    });
    expect(out).toEqual({ value: "from-chain", source: "chain", degraded: true });
    expect((errors[0] as Error).message).toBe("502");
  });

  it("reading from the chain with NO indexer configured is not degraded", async () => {
    // The zero-config deployment is chain-direct by design. Flagging it as
    // degraded would put an outage banner on a perfectly healthy site.
    const out = await readPreferApi({
      apiConfigured: false,
      fromApi: async () => "unused",
      fromChain: async () => "from-chain",
    });
    expect(out).toEqual({ value: "from-chain", source: "chain", degraded: false });
  });

  it("never calls the API when it is not configured", async () => {
    let apiReads = 0;
    await readPreferApi({
      apiConfigured: false,
      fromApi: async () => {
        apiReads++;
        return "x";
      },
      fromChain: async () => "y",
    });
    expect(apiReads).toBe(0);
  });

  it("surfaces the error when BOTH paths fail, rather than an empty screen", async () => {
    await expect(
      readPreferApi({
        apiConfigured: true,
        fromApi: async () => {
          throw new Error("api down");
        },
        fromChain: async () => {
          throw new Error("rpc down");
        },
      }),
    ).rejects.toThrow("rpc down");
  });
});
