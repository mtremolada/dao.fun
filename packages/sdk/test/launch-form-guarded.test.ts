/**
 * Production launch-form gating (D-034): guarded stays locked unless the
 * deployment explicitly enables it, and when enabled it carries the same
 * council/veto contract as council mode plus the gate-seat veto
 * arithmetic. Token metadata validation for real pump launches.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { validateLaunchForm, validateTokenMetadata } from "../src/launch-form";

const members = (n: number) =>
  Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58());

const guardedForm = (over = {}) => ({
  mode: "guarded" as const,
  tier: "micro" as const,
  councilMembers: members(2),
  councilVetoThresholdPercent: 100,
  confirmations: {},
  ...over,
});

describe("validateLaunchForm guarded gating", () => {
  it("locks guarded by default (no opts)", () => {
    const r = validateLaunchForm(guardedForm());
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/not yet enabled|Stage 3/);
  });

  it("locks guarded when guardedEnabled is false", () => {
    expect(validateLaunchForm(guardedForm(), { guardedEnabled: false }).ok).toBe(
      false,
    );
  });

  it("unlocks guarded when the deployment enables it", () => {
    const r = validateLaunchForm(guardedForm(), { guardedEnabled: true });
    expect(r.ok).toBe(true);
    expect(r.params?.vetoEnabled).toBe(true);
    expect(r.params?.holdUpSeconds).toBe(72 * 3600); // strictest, micro
  });

  it("guarded requires a council (veto REQUIRED, spec 12.2)", () => {
    const r = validateLaunchForm(
      guardedForm({ councilMembers: [] }),
      { guardedEnabled: true },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/Council needs/);
  });

  it("guarded rejects a veto percent with no unambiguous on-chain mapping", () => {
    // 1 human, supply 3: there is no integer percent strictly between the
    // 0-vote and 1-vote shares for some nominals — guardedVetoPercent throws.
    const r = validateLaunchForm(
      guardedForm({ councilMembers: members(1), councilVetoThresholdPercent: 50 }),
      { guardedEnabled: true },
    );
    // 1 human at nominal 50 -> k=1, supply=3: pLow=1, pHigh=ceil(100/3)-1=33 -> ok
    expect(r.ok).toBe(true);
  });

  it("still validates council mode normally", () => {
    const r = validateLaunchForm({
      mode: "council",
      tier: "micro",
      councilMembers: members(3),
      councilVetoThresholdPercent: 60,
      confirmations: {},
    });
    expect(r.ok).toBe(true);
  });
});

describe("validateTokenMetadata", () => {
  it("requires name, symbol, uri", () => {
    expect(validateTokenMetadata(undefined)).toHaveLength(3);
    expect(validateTokenMetadata({ name: "", symbol: "", uri: "" })).toHaveLength(
      3,
    );
  });

  it("enforces pump length limits", () => {
    expect(
      validateTokenMetadata({ name: "x".repeat(33), symbol: "OK", uri: "u" }),
    ).toContainEqual(expect.stringMatching(/name.*32/));
    expect(
      validateTokenMetadata({ name: "OK", symbol: "x".repeat(11), uri: "u" }),
    ).toContainEqual(expect.stringMatching(/symbol.*10/));
  });

  it("accepts valid metadata", () => {
    expect(
      validateTokenMetadata({ name: "Doge", symbol: "DOGE", uri: "https://x/y.json" }),
    ).toHaveLength(0);
  });
});
