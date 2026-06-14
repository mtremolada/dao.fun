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
import { Keypair } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  computeContentCommitment,
  type EnhancedListingContent,
} from "../src/enhanced-listing";
import { buildBountyReimbursementIxs } from "../src/actions";
import { MAX_LISTING_REIMBURSEMENT_USDC, USDC_MINT } from "../src/constants";

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

describe("buildBountyReimbursementIxs (USDC payout to the proven payer, no per-launch cap)", () => {
  const vault = Keypair.generate().publicKey;
  const doer = Keypair.generate().publicKey;
  // $299 in USDC base units (6dp) — a typical Enhanced Token Info payment.
  const PAID = 299_000_000n;

  it("builds exactly one USDC SPL transfer from the vault ATA to the doer ATA", () => {
    const ixs = buildBountyReimbursementIxs({
      vault,
      doer,
      usdcAmount: PAID,
      vaultUsdcBalance: 1_000_000_000n,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    // SPL Transfer keys: [source, destination, owner/authority]
    expect(
      ix.keys[0]!.pubkey.equals(
        getAssociatedTokenAddressSync(USDC_MINT, vault, true),
      ),
    ).toBe(true);
    expect(
      ix.keys[1]!.pubkey.equals(
        getAssociatedTokenAddressSync(USDC_MINT, doer, false),
      ),
    ).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[2]!.isSigner).toBe(true);
    // SPL Transfer data: tag(1 byte = 3) + amount(u64 LE)
    expect(ix.data[0]).toBe(3);
    expect(ix.data.readBigUInt64LE(1)).toBe(PAID);
  });

  it("refuses a claim above the known-cost protocol ceiling (over-payment guard)", () => {
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        usdcAmount: MAX_LISTING_REIMBURSEMENT_USDC + 1n,
        vaultUsdcBalance: 10_000_000_000n,
      }),
    ).toThrow(/known-cost ceiling/);
  });

  it("refuses a non-positive amount and a claim above the vault USDC balance", () => {
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        usdcAmount: 0n,
        vaultUsdcBalance: 1_000_000_000n,
      }),
    ).toThrow(/positive/);
    expect(() =>
      buildBountyReimbursementIxs({
        vault,
        doer,
        usdcAmount: PAID,
        vaultUsdcBalance: 1_000n, // treasury holds almost no USDC
      }),
    ).toThrow(/vault USDC balance/);
  });
});
