/**
 * Jupiter Ultra — SOL→USDC conversion for the DEX-paid bounty float (D-036).
 *
 * WHY a keeper module and not a governance instruction: Jupiter Ultra is an
 * execute-NOW API — you request an order, Jupiter returns a freshly-routed,
 * lookup-table-based transaction good for seconds, you sign it and POST it back
 * to /execute to land. That cannot be frozen into an SPL-Governance proposal
 * that executes later (the route would be stale and the treasury PDA can't call
 * a live API mid-execution). So the conversion runs HERE, in the keeper, over an
 * authorized SOL source (see note below), and the reimbursement payout stays the
 * trustless on-chain step the DAO actually votes on.
 *
 * AUTHORITY NOTE: the keeper has no authority over the Squads vault (INV-2). The
 * SOL it converts must come from a source the DAO has authorized — e.g. a
 * bounded `grant` (spec 6.8) into the keeper's conversion account. This module
 * is the conversion ENGINE; the authority to fund it is a governance decision,
 * deliberately kept out of here.
 *
 * Two halves, both pure/offline-testable like the rest of the keeper:
 *   - planUsdcTopUp: decides whether the treasury has accrued enough SOL to top
 *     the USDC float up to target, and how much SOL to convert (no dust swaps).
 *   - JupiterUltraClient: the Ultra order/execute round-trip over an injected
 *     `fetch`, so the network half is mockable with no live calls in tests.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Canonical mints (Solana mainnet). */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ---------------------------------------------------------------------------
// Conversion planner (pure) — "as SOL hits the sufficient amount, convert".
// ---------------------------------------------------------------------------

export interface UsdcTopUpInputs {
  /** Treasury SOL available to the conversion source, in lamports. */
  vaultSolLamports: bigint;
  /** Treasury USDC balance right now, in base units (6 dp). */
  vaultUsdcBaseUnits: bigint;
  /** USDC float to keep ready for reimbursements, in base units. */
  targetUsdcBaseUnits: bigint;
  /** Price: USDC base units obtainable per 1 SOL (caller supplies a live quote). */
  usdcPerSol: bigint;
  /** SOL kept untouched for rent/ops and to absorb slippage, in lamports. */
  reserveSolLamports: bigint;
  /** Skip conversions whose USDC output would fall below this (avoid dust swaps). */
  minTopUpUsdcBaseUnits: bigint;
}

export interface UsdcTopUpPlan {
  shouldConvert: boolean;
  /** SOL to swap this round, in lamports (0 when shouldConvert is false). */
  swapSolLamports: bigint;
  /** Estimated USDC out at the supplied price, in base units (pre-slippage). */
  expectedUsdcBaseUnits: bigint;
  /** Human-readable reason — surfaced to the keeper's observability log. */
  reason: string;
}

const NO_CONVERT = (reason: string): UsdcTopUpPlan => ({
  shouldConvert: false,
  swapSolLamports: 0n,
  expectedUsdcBaseUnits: 0n,
  reason,
});

/**
 * Decide whether to top up the USDC float. Converts only the SOL needed to
 * reach `target` (never more), never touches the SOL reserve, and refuses dust.
 * All math is bigint (INV-6); ceil-divides the SOL needed so a rounding error
 * can never leave the float a base unit short.
 */
export function planUsdcTopUp(p: UsdcTopUpInputs): UsdcTopUpPlan {
  if (p.usdcPerSol <= 0n) return NO_CONVERT("no valid SOL/USDC price");

  const shortfall = p.targetUsdcBaseUnits - p.vaultUsdcBaseUnits;
  if (shortfall <= 0n) return NO_CONVERT("USDC float already at/above target");
  if (shortfall < p.minTopUpUsdcBaseUnits) {
    return NO_CONVERT("shortfall below the minimum top-up");
  }

  const spendableSol = p.vaultSolLamports - p.reserveSolLamports;
  if (spendableSol <= 0n) return NO_CONVERT("no spendable SOL above the reserve");

  // Lamports needed to buy exactly the shortfall, rounded UP.
  const solForShortfall =
    (shortfall * LAMPORTS_PER_SOL + p.usdcPerSol - 1n) / p.usdcPerSol;
  const swapSolLamports =
    solForShortfall < spendableSol ? solForShortfall : spendableSol;
  if (swapSolLamports <= 0n) return NO_CONVERT("no spendable SOL above the reserve");

  const expectedUsdcBaseUnits = (swapSolLamports * p.usdcPerSol) / LAMPORTS_PER_SOL;
  if (expectedUsdcBaseUnits < p.minTopUpUsdcBaseUnits) {
    return NO_CONVERT("affordable conversion is below the minimum top-up");
  }

  return {
    shouldConvert: true,
    swapSolLamports,
    expectedUsdcBaseUnits,
    reason: `convert ${swapSolLamports} lamports -> ~${expectedUsdcBaseUnits} USDC base units`,
  };
}

// ---------------------------------------------------------------------------
// Jupiter Ultra client — order + execute over an injected fetch.
// ---------------------------------------------------------------------------

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface JupiterUltraConfig {
  /** Default is Jupiter's keyless lite host; pass api.jup.ag + apiKey for prod. */
  baseUrl?: string;
  apiKey?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

export interface UltraOrderParams {
  inputMint: string;
  outputMint: string;
  /** Input amount in base units of inputMint (string — may exceed 2^53). */
  amount: string;
  /** The wallet that will sign + execute (the keeper's conversion account). */
  taker: string;
}

export interface UltraOrder {
  /** Base64 unsigned transaction to sign with the taker key. */
  transaction: string;
  /** Opaque id echoed back to /execute so Jupiter lands the exact order. */
  requestId: string;
  inAmount: string;
  outAmount: string;
}

export interface UltraExecuteResult {
  status: string; // "Success" | "Failed"
  signature?: string;
  error?: string;
}

const DEFAULT_BASE_URL = "https://lite-api.jup.ag";

export class JupiterUltraClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(cfg: JupiterUltraConfig = {}) {
    this.baseUrl = (cfg.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = cfg.apiKey;
    const f = cfg.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    if (!f) throw new Error("JupiterUltraClient: no fetch implementation");
    this.fetchImpl = f;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    return h;
  }

  /** GET /ultra/v1/order — Jupiter routes and returns an unsigned transaction. */
  async order(p: UltraOrderParams): Promise<UltraOrder> {
    const q = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount,
      taker: p.taker,
    });
    const res = await this.fetchImpl(`${this.baseUrl}/ultra/v1/order?${q}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`jupiter ultra order: HTTP ${res.status}`);
    const j = (await res.json()) as Partial<UltraOrder>;
    if (!j.transaction || !j.requestId) {
      throw new Error("jupiter ultra order: missing transaction/requestId");
    }
    return {
      transaction: j.transaction,
      requestId: j.requestId,
      inAmount: j.inAmount ?? p.amount,
      outAmount: j.outAmount ?? "0",
    };
  }

  /** POST /ultra/v1/execute — submit the signed order; Jupiter lands it. */
  async execute(p: {
    signedTransaction: string;
    requestId: string;
  }): Promise<UltraExecuteResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/ultra/v1/execute`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        signedTransaction: p.signedTransaction,
        requestId: p.requestId,
      }),
    });
    if (!res.ok) throw new Error(`jupiter ultra execute: HTTP ${res.status}`);
    const j = (await res.json()) as Partial<UltraExecuteResult>;
    return {
      status: j.status ?? "Failed",
      ...(j.signature ? { signature: j.signature } : {}),
      ...(j.error ? { error: j.error } : {}),
    };
  }
}
