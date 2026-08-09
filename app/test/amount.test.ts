/**
 * Amount parsing/formatting for the trade panel. These sit directly on the
 * funds path: a value that rounds UP asks the chain to move more than the
 * wallet holds, which fails as an opaque token-program error.
 */
import { describe, expect, it } from "vitest";
import { formatTokenAmount, parseTokenAmount } from "../lib/amount";

describe("formatTokenAmount / parseTokenAmount round trip", () => {
  it("round-trips a real balance EXACTLY (the 100%-sell bug)", () => {
    // Live devnet balance that broke the old preset: toFixed(4) rendered
    // 533830845.5493, which parsed back to 34 base units MORE than held.
    const held = 533_830_845_549_266n;
    const shown = formatTokenAmount(held, 6);
    expect(shown).toBe("533830845.549266");
    expect(parseTokenAmount(shown, 6)).toBe(held);
  });

  it("never rounds up: extra precision is truncated, not rounded", () => {
    expect(parseTokenAmount("1.9999999", 6)).toBe(1_999_999n);
    expect(parseTokenAmount("0.0000009", 6)).toBe(0n);
  });

  it("handles whole numbers, empty and malformed input", () => {
    expect(parseTokenAmount("5", 6)).toBe(5_000_000n);
    expect(parseTokenAmount("", 6)).toBe(0n);
    expect(parseTokenAmount(".", 6)).toBe(0n);
    expect(parseTokenAmount("abc", 6)).toBe(0n);
    expect(parseTokenAmount("-3", 6)).toBe(0n);
  });

  it("formats without trailing noise", () => {
    expect(formatTokenAmount(5_000_000n, 6)).toBe("5");
    expect(formatTokenAmount(1_500_000n, 6)).toBe("1.5");
    expect(formatTokenAmount(0n, 6)).toBe("0");
  });

  it("works at 9 decimals for SOL amounts too", () => {
    const lamports = 2_536_966_734n;
    const shown = formatTokenAmount(lamports, 9);
    expect(shown).toBe("2.536966734");
    expect(parseTokenAmount(shown, 9)).toBe(lamports);
  });

  it("survives amounts beyond double precision", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    expect(parseTokenAmount(formatTokenAmount(huge, 6), 6)).toBe(huge);
  });
});
