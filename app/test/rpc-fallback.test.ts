/**
 * RPC fallback logic (D-033): firstNonNull powers readWithFallback, which
 * tries each configured endpoint until one returns data — so a rate-limited
 * or down primary doesn't take the read surface down. Pure, tested offline.
 */
import { describe, expect, it } from "vitest";
import { firstNonNull } from "../lib/rpc";

describe("firstNonNull", () => {
  it("returns the first non-null result and stops", async () => {
    const calls: number[] = [];
    const r = await firstNonNull<number>([
      async () => {
        calls.push(1);
        return 7;
      },
      async () => {
        calls.push(2);
        return 9;
      },
    ]);
    expect(r).toBe(7);
    expect(calls).toEqual([1]); // second producer never ran
  });

  it("skips null producers (a down endpoint) to the next", async () => {
    const r = await firstNonNull<string>([
      async () => null,
      async () => "data-from-fallback",
    ]);
    expect(r).toBe("data-from-fallback");
  });

  it("returns null when every endpoint returns null (genuinely not found)", async () => {
    const r = await firstNonNull<string>([async () => null, async () => null]);
    expect(r).toBeNull();
  });

  it("falls through a throwing endpoint to one that succeeds", async () => {
    const r = await firstNonNull<string>([
      async () => {
        throw new Error("429 rate limited");
      },
      async () => "recovered",
    ]);
    expect(r).toBe("recovered");
  });

  it("rethrows the last error when every endpoint throws", async () => {
    await expect(
      firstNonNull<string>([
        async () => {
          throw new Error("primary down");
        },
        async () => {
          throw new Error("fallback down");
        },
      ]),
    ).rejects.toThrow(/fallback down/);
  });
});
