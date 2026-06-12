/**
 * Self-service (decentralized) launch plan — the keyless, browser-buildable
 * launch sequence. Asserts the GROUP order (incl. AUDIT F-3 fee-last and F-12
 * council-before-realm), which ephemeral signer each group needs, the
 * advance-derived treasury, and the fee-omission path.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  buildLaunchPlan,
  deriveTreasuryPdas,
  deriveGovernanceChainFromMint,
  extraSignersFor,
  resolveGovernanceParams,
} from "../src";

const SUPPLY = 1_000_000_000_000_000n;
const programConfigTreasury = Keypair.generate().publicKey;
const protocolTreasury = Keypair.generate().publicKey;

function dummyCreateToken(): TransactionInstruction[] {
  return [
    SystemProgram.transfer({
      fromPubkey: Keypair.generate().publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
  ];
}

function base(overrides: Record<string, unknown> = {}) {
  const launcher = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const createKey = Keypair.generate().publicKey;
  return {
    launcher,
    mint,
    createKey,
    createTokenIxs: dummyCreateToken(),
    programConfigTreasury,
    protocolTreasury,
    launchFeeLamports: 50_000_000n,
    ...overrides,
  };
}

describe("buildLaunchPlan (self-service)", () => {
  it("cypherpunk: keyless groups in the F-3 fee-last order, right signers", async () => {
    const b = base();
    const plan = await buildLaunchPlan({
      ...b,
      mode: "cypherpunk",
      params: resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      }),
    });

    expect(plan.groups.map((g) => g.label)).toEqual([
      "create-treasury",
      "create-token",
      "create-dao:realm",
      "create-dao:governance",
      "prefund-treasury",
      "collect-launch-fee",
    ]);

    const byLabel = Object.fromEntries(plan.groups.map((g) => [g.label, g]));
    // only the ephemeral keypairs co-sign; everything else is the wallet alone
    expect(byLabel["create-treasury"]!.extraSigners.map((k) => k.toBase58())).toEqual([
      b.createKey.toBase58(),
    ]);
    expect(byLabel["create-token"]!.extraSigners.map((k) => k.toBase58())).toEqual([
      b.mint.toBase58(),
    ]);
    expect(byLabel["create-dao:realm"]!.extraSigners).toEqual([]);
    expect(byLabel["prefund-treasury"]!.extraSigners).toEqual([]);
    expect(byLabel["collect-launch-fee"]!.extraSigners).toEqual([]);

    // advance-derivation: the treasury the plan reports is the predicted chain
    const predicted = deriveGovernanceChainFromMint(b.mint);
    const { multisigPda, vaultPda } = deriveTreasuryPdas(b.createKey);
    expect(plan.treasury.nativeTreasury.equals(predicted.nativeTreasury)).toBe(true);
    expect(plan.treasury.realm.equals(predicted.realm)).toBe(true);
    expect(plan.treasury.governance.equals(predicted.governance)).toBe(true);
    expect(plan.treasury.multisigPda.equals(multisigPda)).toBe(true);
    expect(plan.treasury.vaultPda.equals(vaultPda)).toBe(true);

    // the fee transfer pays the user's wallet -> protocol treasury
    const feeIx = byLabel["collect-launch-fee"]!.instructions[0]!;
    const keys = feeIx.keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(b.launcher.toBase58());
    expect(keys).toContain(protocolTreasury.toBase58());
  });

  it("council: the council mint group is inserted BEFORE the realm (F-12)", async () => {
    const councilMint = Keypair.generate().publicKey;
    const member = Keypair.generate().publicKey;
    const plan = await buildLaunchPlan({
      ...base(),
      mode: "council",
      params: resolveGovernanceParams({
        mode: "council",
        tier: "micro",
        communitySupply: SUPPLY,
      }),
      council: {
        mint: councilMint,
        members: [member],
        vetoThresholdPercent: 50,
        mintRentLamports: 1_461_600n,
      },
    });
    const labels = plan.groups.map((g) => g.label);
    expect(labels.indexOf("create-dao:council")).toBeGreaterThan(-1);
    expect(labels.indexOf("create-dao:council")).toBeLessThan(
      labels.indexOf("create-dao:realm"),
    );
    const council = plan.groups.find((g) => g.label === "create-dao:council")!;
    expect(council.extraSigners.map((k) => k.toBase58())).toEqual([
      councilMint.toBase58(),
    ]);
  });

  it("omits the fee group when the launch fee is 0 (a fee-free deploy)", async () => {
    const plan = await buildLaunchPlan({
      ...base({ launchFeeLamports: 0n }),
      mode: "cypherpunk",
      params: resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      }),
    });
    expect(plan.groups.map((g) => g.label)).not.toContain("collect-launch-fee");
  });

  it("extraSignersFor selects exactly the keypairs a group needs", async () => {
    const mintKp = Keypair.generate();
    const createKeyKp = Keypair.generate();
    const plan = await buildLaunchPlan({
      launcher: Keypair.generate().publicKey,
      mint: mintKp.publicKey,
      createKey: createKeyKp.publicKey,
      createTokenIxs: dummyCreateToken(),
      programConfigTreasury,
      launchFeeLamports: 0n,
      mode: "cypherpunk",
      params: resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      }),
    });
    const tokenGroup = plan.groups.find((g) => g.label === "create-token")!;
    const picked = extraSignersFor(tokenGroup, [mintKp, createKeyKp]);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.publicKey.equals(mintKp.publicKey)).toBe(true);
  });

  it("rejects council mode without members", async () => {
    await expect(
      buildLaunchPlan({
        ...base(),
        mode: "council",
        params: resolveGovernanceParams({
          mode: "council",
          tier: "micro",
          communitySupply: SUPPLY,
        }),
      }),
    ).rejects.toThrow(/council/);
  });
});
