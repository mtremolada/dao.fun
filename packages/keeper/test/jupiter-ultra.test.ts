/**
 * Jupiter Ultra conversion engine (D-036). Pure planner + the order/execute
 * round-trip over a mocked fetch — no live calls. Written to pin the bounds the
 * keeper relies on: never spend the reserve, never over-convert past target,
 * never dust-swap, and ceil the SOL needed so the float is never left short.
 */
import { describe, expect, it, vi } from "vitest";
import {
  JupiterUltraClient,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  USDC_MINT,
  planUsdcTopUp,
  type UsdcTopUpInputs,
} from "../src/jupiter-ultra";

// ~$150/SOL expressed as USDC base units (6dp) per SOL.
const USDC_PER_SOL = 150_000_000n;

const base: UsdcTopUpInputs = {
  vaultSolLamports: 10n * LAMPORTS_PER_SOL,
  vaultUsdcBaseUnits: 0n,
  targetUsdcBaseUnits: 300_000_000n, // $300 float
  usdcPerSol: USDC_PER_SOL,
  reserveSolLamports: LAMPORTS_PER_SOL, // keep 1 SOL
  minTopUpUsdcBaseUnits: 10_000_000n, // skip < $10
};

describe("planUsdcTopUp", () => {
  it("converts just enough SOL to reach the target float (ceil, never short)", () => {
    const plan = planUsdcTopUp(base);
    expect(plan.shouldConvert).toBe(true);
    // $300 at $150/SOL = 2 SOL.
    expect(plan.swapSolLamports).toBe(2n * LAMPORTS_PER_SOL);
    expect(plan.expectedUsdcBaseUnits).toBe(300_000_000n);
    // and it never dips into the reserve
    expect(plan.swapSolLamports).toBeLessThanOrEqual(
      base.vaultSolLamports - base.reserveSolLamports,
    );
  });

  it("does nothing when the float is already at/above target", () => {
    const plan = planUsdcTopUp({ ...base, vaultUsdcBaseUnits: 300_000_000n });
    expect(plan.shouldConvert).toBe(false);
    expect(plan.swapSolLamports).toBe(0n);
    expect(plan.reason).toMatch(/at\/above target/);
  });

  it("only tops up the shortfall, not the whole target", () => {
    // already holds $250 -> needs $50 -> at $150/SOL = 1/3 SOL.
    const plan = planUsdcTopUp({ ...base, vaultUsdcBaseUnits: 250_000_000n });
    expect(plan.shouldConvert).toBe(true);
    expect(plan.expectedUsdcBaseUnits).toBeGreaterThanOrEqual(50_000_000n);
    expect(plan.swapSolLamports).toBeLessThan(LAMPORTS_PER_SOL); // < 1 SOL
  });

  it("refuses to touch the reserve: caps the swap at spendable SOL", () => {
    // only 1.5 SOL total, reserve 1 SOL -> at most 0.5 SOL spendable
    const plan = planUsdcTopUp({
      ...base,
      vaultSolLamports: (3n * LAMPORTS_PER_SOL) / 2n,
    });
    expect(plan.swapSolLamports).toBe(LAMPORTS_PER_SOL / 2n);
    expect(plan.expectedUsdcBaseUnits).toBe(75_000_000n); // 0.5 SOL * $150
  });

  it("skips dust: no conversion below the minimum top-up", () => {
    // shortfall of only $5 (< $10 min)
    const plan = planUsdcTopUp({ ...base, vaultUsdcBaseUnits: 295_000_000n });
    expect(plan.shouldConvert).toBe(false);
    expect(plan.reason).toMatch(/below the minimum/);
  });

  it("does nothing with no spendable SOL or no price", () => {
    expect(
      planUsdcTopUp({ ...base, vaultSolLamports: base.reserveSolLamports }).shouldConvert,
    ).toBe(false);
    expect(planUsdcTopUp({ ...base, usdcPerSol: 0n }).shouldConvert).toBe(false);
  });
});

describe("JupiterUltraClient (mocked fetch)", () => {
  const okJson = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("requests an order with the SOL->USDC params and returns the tx + requestId", async () => {
    const fetchImpl = vi.fn().mockReturnValue(
      okJson({
        transaction: "BASE64TX",
        requestId: "req-1",
        inAmount: "2000000000",
        outAmount: "300000000",
      }),
    );
    const client = new JupiterUltraClient({ fetchImpl });
    const order = await client.order({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: "2000000000",
      taker: "Taker1111111111111111111111111111111111111",
    });
    expect(order.transaction).toBe("BASE64TX");
    expect(order.requestId).toBe("req-1");
    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url).toContain("/ultra/v1/order?");
    expect(url).toContain(`inputMint=${SOL_MINT}`);
    expect(url).toContain(`outputMint=${USDC_MINT}`);
    expect(url).toContain("amount=2000000000");
  });

  it("executes a signed order and surfaces the landed signature", async () => {
    const fetchImpl = vi
      .fn()
      .mockReturnValue(okJson({ status: "Success", signature: "SIG123" }));
    const client = new JupiterUltraClient({ fetchImpl });
    const res = await client.execute({
      signedTransaction: "SIGNEDB64",
      requestId: "req-1",
    });
    expect(res.status).toBe("Success");
    expect(res.signature).toBe("SIG123");
    const [, init] = fetchImpl.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      signedTransaction: "SIGNEDB64",
      requestId: "req-1",
    });
  });

  it("throws on a non-OK HTTP status and on a malformed order", async () => {
    const bad = vi.fn().mockReturnValue(
      Promise.resolve({ ok: false, status: 429, json: () => Promise.resolve({}) }),
    );
    await expect(
      new JupiterUltraClient({ fetchImpl: bad }).order({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: "1",
        taker: "T",
      }),
    ).rejects.toThrow(/HTTP 429/);

    const missing = vi.fn().mockReturnValue(okJson({ requestId: "x" })); // no transaction
    await expect(
      new JupiterUltraClient({ fetchImpl: missing }).order({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: "1",
        taker: "T",
      }),
    ).rejects.toThrow(/missing transaction/);
  });
});
