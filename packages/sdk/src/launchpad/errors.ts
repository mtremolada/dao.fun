/**
 * Anchor custom error codes → human messages. Anchor numbers user errors
 * from 6000 in declaration order; this list mirrors the `LaunchpadError`
 * enum in programs/launchpad-curve/src/lib.rs (keep them in step). The point
 * is the "never show 0x1771" MUST: the trade panel decodes a failed
 * simulation into a sentence, not a hex code.
 */
export const LAUNCHPAD_ERROR_MESSAGES: Record<number, string> = {
  6000: "Total trade fee is outside the permitted range.",
  6001: "Curve parameters are invalid.",
  6002: "This curve cannot raise enough to cover its own graduation.",
  6003: "Trading is closed — this curve has completed.",
  6004: "This curve has not completed yet.",
  6005: "This curve has already graduated.",
  6006: "Amount must be greater than zero.",
  6007: "Price moved past your slippage tolerance. Try again.",
  6008: "The curve's reserve can't cover this trade.",
  6009: "That token account doesn't belong to this coin.",
  6010: "Fee recipient doesn't match the configured address.",
  6011: "A Raydium account doesn't match the configured address.",
  6012: "The Raydium AMM config account is malformed.",
  6013: "Nothing to collect.",
  6014: "Arithmetic overflow.",
  6015: "Unauthorized.",
  6016: "A metadata field is too long.",
};

/** A few anchor framework codes worth naming when they surface. */
const ANCHOR_FRAMEWORK_MESSAGES: Record<number, string> = {
  2001: "An account constraint (has_one) was violated.",
  2003: "An account constraint was violated.",
  2006: "A seeds constraint was violated.",
  2012: "An account address constraint was violated.",
  3012: "A required account was not initialized.",
};

/**
 * Best-effort human message for a program error surfaced from a simulation
 * or a failed send. Accepts the raw number, or a log/message string we try
 * to pull a `custom program error: 0xNNN` or `Error Number: N` out of.
 */
export function explainLaunchpadError(input: number | string): string | undefined {
  let code: number | undefined;
  if (typeof input === "number") code = input;
  else {
    const hex = input.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
    const dec = input.match(/Error Number:\s*(\d+)/);
    if (hex?.[1]) code = parseInt(hex[1], 16);
    else if (dec?.[1]) code = parseInt(dec[1], 10);
  }
  if (code === undefined) return undefined;
  return LAUNCHPAD_ERROR_MESSAGES[code] ?? ANCHOR_FRAMEWORK_MESSAGES[code];
}
