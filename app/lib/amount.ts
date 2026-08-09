/**
 * Decimal <-> base-unit conversion for the trade panel, done as STRING
 * arithmetic.
 *
 * Doing this through a double is what produced the "sell 100% fails" bug: a
 * balance of 533830845.549266 rendered with toFixed(4) became
 * "533830845.5493", which parsed back to 34 base units MORE than the wallet
 * held, so the token transfer failed with an opaque InsufficientFunds. Here
 * nothing rounds up — extra precision is truncated — and a value formatted
 * from base units parses back to exactly those base units.
 */

/** Base units for a decimal string. Truncates past `decimals`; never rounds up. */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return 0n;
  const [whole = "", frac = ""] = trimmed.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
  } catch {
    return 0n;
  }
}

/** Full-precision rendering of base units — the inverse of parseTokenAmount. */
export function formatTokenAmount(base: bigint, decimals: number): string {
  const negative = base < 0n;
  const v = negative ? -base : base;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
