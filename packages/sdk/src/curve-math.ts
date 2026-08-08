/**
 * Launchpad bonding-curve math (SPEC-LAUNCHPAD.md §1).
 *
 * THIS MODULE IS THE SPECIFICATION. The on-chain program mirrors it
 * operation for operation — same order, same rounding direction, same
 * clamps — and tests/launchpad-parity.integration.test.ts proves the two
 * agree exactly over randomized trade sequences. Change the order of
 * operations here and you have changed the program's contract.
 *
 * Constant product over VIRTUAL reserves, so the opening price is finite:
 *
 *     k = virtual_sol * virtual_token
 *
 * Rounding is always in the curve's favour, on both sides. A buyer's cost
 * rounds up; a seller's proceeds round down; fees round up. The dust stays
 * with the pool, which is what makes a buy-then-sell round trip strictly
 * unprofitable and keeps k from drifting downward over millions of trades.
 *
 * Pure bigint, no dependencies — the browser bundles this to quote trades,
 * so it must not drag in @solana/web3.js.
 */

export interface CurveParams {
  /** Virtual SOL seeded at creation; sets the opening price. */
  initialVirtualSol: bigint;
  /** Virtual tokens seeded at creation. */
  initialVirtualToken: bigint;
  /** Tokens actually sellable on the curve. */
  initialRealToken: bigint;
  /** Full mint supply; the remainder seeds the graduation pool. */
  tokenTotalSupply: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
}

export interface CurveState {
  virtualSol: bigint;
  virtualToken: bigint;
  /** Lamports the curve actually holds. */
  realSol: bigint;
  /** Tokens still purchasable. */
  realToken: bigint;
  /**
   * Fee rates snapshotted at creation (INV-FEE-SNAPSHOT): a later config
   * change must not be able to retax a coin that is already trading.
   */
  protocolFeeBps: number;
  creatorFeeBps: number;
  /** One-way. Set when the real reserve empties; closes trading forever. */
  complete: boolean;
}

export interface BuyQuote {
  /** Tokens delivered — may be less than requested on the final buy. */
  tokensOut: bigint;
  /** Lamports entering the curve's reserves. */
  curveCost: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** What the buyer pays: curve cost with the fees added on top. */
  totalCost: bigint;
}

export interface SellQuote {
  /** Lamports leaving the curve's reserves. */
  grossSol: bigint;
  protocolFee: bigint;
  creatorFee: bigint;
  /** What the seller receives, after fees are taken out of the gross. */
  netSol: bigint;
}

export const BPS_DENOMINATOR = 10_000n;
/** A zero-fee path makes wash trading free (Meteora's cliff_fee finding). */
export const MIN_TOTAL_FEE_BPS = 10;
/** Ceiling on what a compromised authority could ever impose. */
export const MAX_TOTAL_FEE_BPS = 500;

/** Production economics. */
export const PUMP_CLASSIC: CurveParams = {
  initialVirtualSol: 30_000_000_000n,
  initialVirtualToken: 1_073_000_000_000_000n,
  initialRealToken: 793_100_000_000_000n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  protocolFeeBps: 70,
  creatorFeeBps: 30,
};

/**
 * GATE L2 economics. Completing a full curve costs ~85 SOL and the devnet
 * faucet yields 2-5 SOL per cycle, so virtual SOL is scaled by 30 and
 * nothing else moves. Same code path, smaller numbers — devnet evidence is
 * evidence about code, never about production economics (D-033).
 */
export const DEVNET_SCALED: CurveParams = {
  ...PUMP_CLASSIC,
  initialVirtualSol: 1_000_000_000n,
};

const ceilDiv = (numerator: bigint, denominator: bigint): bigint =>
  numerator % denominator === 0n
    ? numerator / denominator
    : numerator / denominator + 1n;

export function initialState(params: CurveParams): CurveState {
  return {
    virtualSol: params.initialVirtualSol,
    virtualToken: params.initialVirtualToken,
    realSol: 0n,
    realToken: params.initialRealToken,
    protocolFeeBps: params.protocolFeeBps,
    creatorFeeBps: params.creatorFeeBps,
    complete: false,
  };
}

/**
 * The lamports a curve holds the moment it completes, if the whole reserve
 * is bought at once. Every buy rounds up, so a curve bought in many steps
 * raises strictly more — this is the floor, and the number migration sizes
 * its reserve against.
 */
export function raiseAtCompletion(params: CurveParams): bigint {
  return ceilDiv(
    params.initialRealToken * params.initialVirtualSol,
    params.initialVirtualToken - params.initialRealToken,
  );
}

/**
 * Rejects a parameter set the program must never accept.
 *
 * `migrationOverheadLamports` is the pool-creation fee plus rent (read from
 * the live AmmConfig, not hardcoded). A curve whose entire raise cannot
 * cover graduation twice over would strand its holders' SOL: it would
 * complete, and then be unable to migrate (INV-GRAD-COVERS-COST).
 */
export function validateParams(
  params: CurveParams,
  migrationOverheadLamports: bigint,
): void {
  const total = params.protocolFeeBps + params.creatorFeeBps;
  if (
    !Number.isInteger(params.protocolFeeBps) ||
    !Number.isInteger(params.creatorFeeBps) ||
    params.protocolFeeBps < 0 ||
    params.creatorFeeBps < 0 ||
    total < MIN_TOTAL_FEE_BPS ||
    total > MAX_TOTAL_FEE_BPS
  ) {
    throw new Error(
      `total fee ${total} bps is outside the permitted range ` +
        `[${MIN_TOTAL_FEE_BPS}, ${MAX_TOTAL_FEE_BPS}]`,
    );
  }
  if (params.initialRealToken >= params.initialVirtualToken) {
    throw new Error("initialRealToken must be below initialVirtualToken");
  }
  if (params.initialRealToken > params.tokenTotalSupply) {
    throw new Error("initialRealToken must not exceed tokenTotalSupply");
  }
  if (params.initialVirtualSol <= 0n) {
    throw new Error("initialVirtualSol must be positive");
  }
  const raise = raiseAtCompletion(params);
  if (raise < migrationOverheadLamports * 2n) {
    throw new Error(
      `completion raise ${raise} does not cover graduation: migration ` +
        `overhead is ${migrationOverheadLamports} lamports and the curve ` +
        `must raise at least twice that`,
    );
  }
}

function splitFee(
  base: bigint,
  state: Pick<CurveState, "protocolFeeBps" | "creatorFeeBps">,
  cap?: bigint,
): { protocolFee: bigint; creatorFee: bigint } {
  const totalBps = BigInt(state.protocolFeeBps + state.creatorFeeBps);
  if (totalBps === 0n || base === 0n) {
    return { protocolFee: 0n, creatorFee: 0n };
  }
  // Rounded up so a fee is never rounded away to nothing (INV-FEE-FLOOR),
  // then capped where the caller cannot afford it (dust sells).
  let total = ceilDiv(base * totalBps, BPS_DENOMINATOR);
  if (cap !== undefined && total > cap) total = cap;
  // Split by share of the configured bps; the protocol absorbs the
  // remainder so the two parts always re-sum to `total` exactly.
  const creatorFee = (total * BigInt(state.creatorFeeBps)) / totalBps;
  return { protocolFee: total - creatorFee, creatorFee };
}

/**
 * Exact-token-out pricing. The buyer names the tokens they want and learns
 * the cost; the final buy is truncated to whatever the curve has left
 * (INV-RESERVE-CAP) rather than failing, so the curve can always be closed.
 */
export function buyQuote(state: CurveState, tokenAmount: bigint): BuyQuote {
  if (state.complete) {
    throw new Error("curve is complete: trading is closed");
  }
  if (tokenAmount <= 0n) {
    throw new Error("buy amount must be positive");
  }
  const tokensOut = tokenAmount > state.realToken ? state.realToken : tokenAmount;
  // Rounded up: the buyer covers the exact curve price or better, never
  // less, so k cannot fall (INV-ROUND-BUY, INV-K-NONDECREASING).
  const curveCost = ceilDiv(
    tokensOut * state.virtualSol,
    state.virtualToken - tokensOut,
  );
  // Fees sit ON TOP of the curve cost: only curveCost enters the reserves.
  const { protocolFee, creatorFee } = splitFee(curveCost, state);
  return {
    tokensOut,
    curveCost,
    protocolFee,
    creatorFee,
    totalCost: curveCost + protocolFee + creatorFee,
  };
}

export function applyBuy(state: CurveState, quote: BuyQuote): CurveState {
  const realToken = state.realToken - quote.tokensOut;
  return {
    ...state,
    virtualSol: state.virtualSol + quote.curveCost,
    virtualToken: state.virtualToken - quote.tokensOut,
    realSol: state.realSol + quote.curveCost,
    realToken,
    // One-way, and set by exactly one condition (INV-COMPLETE-MONOTONE).
    complete: state.complete || realToken === 0n,
  };
}

/**
 * Sell pricing. Fees come OUT of the gross proceeds here (the mirror image
 * of buys), and are capped at the gross so a dust sell settles at zero
 * rather than underflowing (INV-SELL-NO-UNDERFLOW).
 */
export function sellQuote(state: CurveState, tokenAmount: bigint): SellQuote {
  if (state.complete) {
    throw new Error("curve is complete: trading is closed");
  }
  if (tokenAmount <= 0n) {
    throw new Error("sell amount must be positive");
  }
  // Floor-rounded: the seller never receives more than the exact curve
  // price, so k cannot fall (INV-ROUND-SELL, INV-K-NONDECREASING).
  const grossSol =
    (tokenAmount * state.virtualSol) / (state.virtualToken + tokenAmount);
  // The curve can only pay out what it actually holds. On chain the token
  // transfer already bounds the seller to tokens they own; this is the
  // reserve-side backstop that makes the vault accounting total.
  if (grossSol > state.realSol) {
    throw new Error("sell exceeds the curve's reserve");
  }
  const { protocolFee, creatorFee } = splitFee(grossSol, state, grossSol);
  return {
    grossSol,
    protocolFee,
    creatorFee,
    netSol: grossSol - protocolFee - creatorFee,
  };
}

export function applySell(
  state: CurveState,
  tokenAmount: bigint,
  quote: SellQuote,
): CurveState {
  return {
    ...state,
    virtualSol: state.virtualSol - quote.grossSol,
    virtualToken: state.virtualToken + tokenAmount,
    realSol: state.realSol - quote.grossSol,
    realToken: state.realToken + tokenAmount,
  };
}

/**
 * Inverts the buy curve for the trade panel: "I have this many lamports,
 * how many tokens is that?". Binary search rather than a closed form,
 * because the closed form has to agree with `buyQuote`'s rounding at the
 * boundary and searching against the real function cannot drift from it.
 * The result is always affordable — never a quote the user cannot pay.
 */
export function tokensForSolInput(
  state: CurveState,
  budgetLamports: bigint,
): bigint {
  if (state.complete || budgetLamports <= 0n || state.realToken === 0n) {
    return 0n;
  }
  if (buyQuote(state, 1n).totalCost > budgetLamports) return 0n;

  let low = 1n; // known affordable
  let high = state.realToken;
  if (buyQuote(state, high).totalCost <= budgetLamports) return high;
  // Invariant: low is affordable, high is not.
  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (buyQuote(state, mid).totalCost <= budgetLamports) low = mid;
    else high = mid;
  }
  return low;
}

/** Curve completion, in basis points, for the progress bar. */
export function progressBps(state: CurveState, params: CurveParams): number {
  if (params.initialRealToken === 0n) return 10_000;
  const sold = params.initialRealToken - state.realToken;
  return Number((sold * 10_000n) / params.initialRealToken);
}

/** Fully-diluted market cap in lamports, at the current curve price. */
export function marketCapLamports(
  state: CurveState,
  params: CurveParams,
): bigint {
  return (state.virtualSol * params.tokenTotalSupply) / state.virtualToken;
}
