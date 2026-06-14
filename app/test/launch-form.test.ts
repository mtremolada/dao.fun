/**
 * Spec 6.7 — UI logic contract (written before implementation). These are
 * the framework-free rules the Next.js components render; the server
 * re-validates with the same functions. Playwright e2e lands with the shell.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  executeButtonState,
  hashBadge,
  validateLaunchForm,
} from "../lib/launch-form";

const member = () => Keypair.generate().publicKey.toBase58();

describe("validateLaunchForm — floors are floors (spec 6.7)", () => {
  it("accepts a plain cypherpunk micro launch with one explicit confirmation", () => {
    const result = validateLaunchForm({
      mode: "cypherpunk",
      tier: "micro",
      confirmations: { noVetoIrreversible: true },
    });
    expect(result.ok).toBe(true);
  });

  it("cypherpunk without its confirmation is rejected", () => {
    const result = validateLaunchForm({
      mode: "cypherpunk",
      tier: "micro",
      confirmations: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/confirmation/i);
  });

  it("rejects sub-floor overrides; accepts stricter-than-floor", () => {
    const below = validateLaunchForm({
      mode: "council",
      tier: "micro",
      councilMembers: [member()],
      councilVetoThresholdPercent: 60,
      overrides: { holdUpSeconds: 3600 }, // micro floor is 72h
      confirmations: {},
    });
    expect(below.ok).toBe(false);
    expect(below.errors.join()).toMatch(/below the micro tier floor/);

    const stricter = validateLaunchForm({
      mode: "council",
      tier: "micro",
      councilMembers: [member()],
      councilVetoThresholdPercent: 60,
      overrides: { holdUpSeconds: 100 * 3600 },
      confirmations: {},
    });
    expect(stricter.ok).toBe(true);
    expect(stricter.params!.holdUpSeconds).toBe(100 * 3600);
  });

  it("sovereign requires BOTH confirmations and an explicit hold-up", () => {
    const oneConfirm = validateLaunchForm({
      mode: "sovereign",
      tier: "micro",
      sovereignHoldUpSeconds: 0,
      confirmations: { noVeto: true },
    });
    expect(oneConfirm.ok).toBe(false);

    const both = validateLaunchForm({
      mode: "sovereign",
      tier: "micro",
      sovereignHoldUpSeconds: 0,
      confirmations: { noVeto: true, canDrainImmediately: true },
    });
    expect(both.ok).toBe(true);
    expect(both.params!.holdUpSeconds).toBe(0);

    const noHoldUp = validateLaunchForm({
      mode: "sovereign",
      tier: "micro",
      confirmations: { noVeto: true, canDrainImmediately: true },
    });
    expect(noHoldUp.ok).toBe(false);
  });

  it("council needs 1..10 members and a veto threshold in (0,100]", () => {
    expect(
      validateLaunchForm({
        mode: "council",
        tier: "small",
        councilMembers: [],
        councilVetoThresholdPercent: 60,
        confirmations: {},
      }).ok,
    ).toBe(false);
    expect(
      validateLaunchForm({
        mode: "council",
        tier: "small",
        councilMembers: [member()],
        councilVetoThresholdPercent: 0,
        confirmations: {},
      }).ok,
    ).toBe(false);
    expect(
      validateLaunchForm({
        mode: "council",
        tier: "small",
        councilMembers: [member(), member()],
        councilVetoThresholdPercent: 60,
        confirmations: {},
      }).ok,
    ).toBe(true);
  });

  it("guarded mode is not selectable before Stage 3", () => {
    const result = validateLaunchForm({
      mode: "guarded",
      tier: "micro",
      confirmations: {},
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join()).toMatch(/Stage 3/);
  });
});

describe("validateLaunchForm — enhanced DEX listing (D-033)", () => {
  const enabled = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    feeCapSol: "1.6",
    description: "A community token.",
    bannerProvided: true,
    ...over,
  });

  it("accepts a valid enhanced listing on a cypherpunk launch", () => {
    const r = validateLaunchForm({
      mode: "cypherpunk",
      tier: "micro",
      confirmations: { noVetoIrreversible: true },
      enhancedListing: enabled(),
    });
    expect(r.ok).toBe(true);
  });

  it("is available across council and sovereign too", () => {
    expect(
      validateLaunchForm({
        mode: "council",
        tier: "small",
        councilMembers: [member()],
        councilVetoThresholdPercent: 60,
        confirmations: {},
        enhancedListing: enabled(),
      }).ok,
    ).toBe(true);
    expect(
      validateLaunchForm({
        mode: "sovereign",
        tier: "micro",
        sovereignHoldUpSeconds: 0,
        confirmations: { noVeto: true, canDrainImmediately: true },
        enhancedListing: enabled(),
      }).ok,
    ).toBe(true);
  });

  it("requires a banner, a description, and a positive fee cap", () => {
    const base = {
      mode: "cypherpunk" as const,
      tier: "micro" as const,
      confirmations: { noVetoIrreversible: true },
    };
    expect(
      validateLaunchForm({
        ...base,
        enhancedListing: enabled({ bannerProvided: false }),
      }).errors.join(),
    ).toMatch(/banner/i);
    expect(
      validateLaunchForm({
        ...base,
        enhancedListing: enabled({ description: "   " }),
      }).errors.join(),
    ).toMatch(/description/i);
    for (const bad of ["0", "-1", "abc", ""]) {
      expect(
        validateLaunchForm({
          ...base,
          enhancedListing: enabled({ feeCapSol: bad }),
        }).errors.join(),
      ).toMatch(/fee cap/i);
    }
  });

  it("ignores the section when disabled or absent (regression)", () => {
    expect(
      validateLaunchForm({
        mode: "cypherpunk",
        tier: "micro",
        confirmations: { noVetoIrreversible: true },
        enhancedListing: enabled({
          enabled: false,
          bannerProvided: false,
          description: "",
          feeCapSol: "0",
        }),
      }).ok,
    ).toBe(true);
    expect(
      validateLaunchForm({
        mode: "cypherpunk",
        tier: "micro",
        confirmations: { noVetoIrreversible: true },
      }).ok,
    ).toBe(true);
  });
});

describe("hashBadge (INV-9 surface)", () => {
  it("verified iff the recomputed chain hash equals the artifact hash", () => {
    expect(hashBadge("abc", "abc")).toBe("verified");
    expect(hashBadge("abc", "abd")).toBe("mismatch");
    expect(hashBadge("abc", null)).toBe("missing");
  });
});

describe("executeButtonState (INV-3 surface)", () => {
  const votingCompletedAt = 1_000_000; // unix seconds
  const holdUp = 72 * 3600;

  it("disabled with a countdown until the hold-up elapses", () => {
    const before = executeButtonState(votingCompletedAt + holdUp - 1, votingCompletedAt, holdUp);
    expect(before.enabled).toBe(false);
    expect(before.remainingSeconds).toBe(1);
  });

  it("enabled exactly at hold-up expiry", () => {
    const at = executeButtonState(votingCompletedAt + holdUp, votingCompletedAt, holdUp);
    expect(at.enabled).toBe(true);
    expect(at.remainingSeconds).toBe(0);
  });
});
