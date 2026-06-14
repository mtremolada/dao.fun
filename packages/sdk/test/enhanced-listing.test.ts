/**
 * Enhanced DEX Listing — content commitment + capped reimbursement payout
 * (D-036, spec 6.x). Written before implementation. The commitment is the
 * tamper-evidence anchor (INV-9 lineage): a community member can only submit
 * the EXACT content the DAO committed at launch. The reimbursement is a
 * `grant` with one extra bound — it can never exceed the committed fee cap
 * (INV-12) — so the fixed action menu (6.8) and the Guarded gate (D-030) are
 * untouched.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  computeContentCommitment,
  type EnhancedListingContent,
} from "../src/enhanced-listing";
import { buildBountyReimbursementIxs } from "../src/actions";

const baseContent: EnhancedListingContent = {
  bannerCid: "bafybeibanner",
  logoCid: "bafybeilogo",
  description: "A community token.",
  twitter: "https://x.com/foo",
  telegram: "https://t.me/foo",
  website: "https://foo.xyz",
  discord: "https://discord.gg/foo",
};

describe("computeContentCommitment (tamper-evident, INV-9 lineage)", () => {
  it("is a 64-char hex sha256 and deterministic", () => {
    const h = computeContentCommitment(baseContent);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(computeContentCommitment(baseContent)).toBe(h);
  });

  it("does not depend on object key declaration order (canonical, fixed order)", () => {
    const reordered: EnhancedListingContent = {
      discord: baseContent.discord,
      website: baseContent.website,
      description: baseContent.description,
      bannerCid: baseContent.bannerCid,
      telegram: baseContent.telegram,
      logoCid: baseContent.logoCid,
      twitter: baseContent.twitter,
    };
    expect(computeContentCommitment(reordered)).toBe(
      computeContentCommitment(baseContent),
    );
  });

  it("changes when ANY committed field changes (banner, description, a social, logo)", () => {
    const h = computeContentCommitment(baseContent);
    expect(
      computeContentCommitment({ ...baseContent, bannerCid: "bafyOTHER" }),
    ).not.toBe(h);
    expect(
      computeContentCommitment({ ...baseContent, description: "different" }),
    ).not.toBe(h);
    expect(
      computeContentCommitment({ ...baseContent, twitter: "https://x.com/bar" }),
    ).not.toBe(h);
    // dropping an optional field changes the commitment too
    const { logoCid: _omit, ...noLogo } = baseContent;
    expect(computeContentCommitment(noLogo)).not.toBe(h);
  });

  it("length-frames fields so adjacent values cannot collide", () => {
    // "ab"+"" across the banner|description boundary must differ from "a"+"b"
    const a = computeContentCommitment({ bannerCid: "ab", description: "" });
    const b = computeContentCommitment({ bannerCid: "a", description: "b" });
    expect(a).not.toBe(b);
  });
});

describe("buildBountyReimbursementIxs (capped grant to the proven payer, INV-12)", () => {
  const vault = Keypair.generate().publicKey;
  const doer = Keypair.generate().publicKey;

  it("builds exactly one SystemProgram transfer of the claimed amount to the doer", () => {
    const ixs = buildBountyReimbursementIxs({
      vault,
      doer,
      claimedLamports: 1_500_000_000n,
      feeCapLamports: 2_000_000_000n,
      vaultBalanceLamports: 5_000_000_000n,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(doer)).toBe(true);
    expect(ix.keys).toHaveLength(2); // no accounts outside the declared set
    expect(ix.data.readBigUInt64LE(4)).toBe(1_500_000_000n);
  });

  it("refuses a claim above the committed fee cap (INV-12)", () => {
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        claimedLamports: 2_000_000_001n,
        feeCapLamports: 2_000_000_000n,
        vaultBalanceLamports: 5_000_000_000n,
      }),
    ).toThrow(/fee cap/);
  });

  it("inherits the grant bounds: zero, over-balance, and rent-floor strip (D-009)", () => {
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        claimedLamports: 0n,
        feeCapLamports: 2_000_000_000n,
        vaultBalanceLamports: 5_000_000_000n,
      }),
    ).toThrow(/positive/);
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        claimedLamports: 1_000n,
        feeCapLamports: 2_000_000_000n,
        vaultBalanceLamports: 500n,
      }),
    ).toThrow(/exceeds vault balance/);
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        claimedLamports: 900_000n,
        feeCapLamports: 2_000_000_000n,
        vaultBalanceLamports: 1_000_000n,
        rentFloorLamports: 890_880n,
      }),
    ).toThrow(/rent floor/);
  });
});
