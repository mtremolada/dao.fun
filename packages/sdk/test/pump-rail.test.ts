/**
 * Spec 6.1 — PumpFunRail tests (written before implementation).
 * Unit-level: no network. On-chain vault check happens in the Stage 1
 * integration suite; here the installed pump-sdk + IDL act as oracles.
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  ammCreatorVaultPda,
  creatorVaultPda,
  pumpIdl,
} from "@pump-fun/pump-sdk";
import type { LaunchParams } from "../src/types";
import {
  FeatureUnavailableError,
  PumpFunRail,
} from "../src/rails/pumpfun";

const coder = new BorshInstructionCoder(
  pumpIdl as ConstructorParameters<typeof BorshInstructionCoder>[0],
);

function launchParams(overrides: Partial<LaunchParams> = {}): LaunchParams {
  return {
    metadata: { name: "Test Token", symbol: "TST", uri: "https://x.test/m.json" },
    daoConfig: { mode: "cypherpunk", marketCapTier: "micro" },
    rail: "pumpfun",
    launcher: Keypair.generate().publicKey,
    ...overrides,
  };
}

// Connection stub: collect builders only call getMultipleAccountsInfo.
const offlineConnection = {
  getMultipleAccountsInfo: async () => [null, null],
} as unknown as Connection;

describe("PumpFunRail.deriveCreatorVault (spec 6.1)", () => {
  const rail = new PumpFunRail(offlineConnection);
  const creator = Keypair.generate().publicKey;

  it("returns the hyphen-seed bonding-curve vault (oracle: pump-sdk)", () => {
    expect(rail.deriveCreatorVault(creator).equals(creatorVaultPda(creator))).toBe(
      true,
    );
  });

  it("sibling helper returns the AMM underscore variant (oracle: pump-sdk)", () => {
    expect(
      rail
        .deriveAmmCreatorVaultAuthority(creator)
        .equals(ammCreatorVaultPda(creator)),
    ).toBe(true);
  });
});

describe("PumpFunRail.buildCreateTokenIxs (INV-1)", () => {
  const rail = new PumpFunRail(offlineConnection);

  it("encodes creator == provided pubkey in ix data; creator never a signer; mint signs", async () => {
    const creator = Keypair.generate().publicKey; // the future Squads vault PDA
    const mint = Keypair.generate();
    const ixs = await rail.buildCreateTokenIxs(launchParams(), creator, mint);

    const createIx = ixs.find((ix) => {
      const decoded = coder.decode(ix.data);
      return decoded?.name === "create_v2";
    });
    expect(createIx, "a create_v2 instruction must be present").toBeDefined();

    const decoded = coder.decode(createIx!.data)!;
    const args = decoded.data as { creator: PublicKey };
    expect(args.creator.equals(creator)).toBe(true);

    for (const ix of ixs) {
      for (const meta of ix.keys) {
        if (meta.pubkey.equals(creator)) {
          expect(meta.isSigner, "creator must never be a signer").toBe(false);
        }
      }
    }
    const mintMeta = createIx!.keys.find((k) => k.pubkey.equals(mint.publicKey));
    expect(mintMeta?.isSigner).toBe(true);
  });

  it("throws when launcher is missing (create_v2 requires a user signer)", async () => {
    const params = launchParams();
    delete params.launcher;
    await expect(
      rail.buildCreateTokenIxs(params, Keypair.generate().publicKey, Keypair.generate()),
    ).rejects.toThrow(/launcher/);
  });
});

describe("PumpFunRail.buildCollectFeesIxs (INV-2)", () => {
  it("signer set is a subset of {fee-payer}", async () => {
    const rail = new PumpFunRail(offlineConnection);
    const creator = Keypair.generate().publicKey;
    const feePayer = Keypair.generate().publicKey;
    const ixs = await rail.buildCollectFeesIxs(creator, feePayer);
    expect(ixs.length).toBeGreaterThan(0);
    for (const ix of ixs) {
      for (const meta of ix.keys) {
        if (meta.isSigner) {
          expect(meta.pubkey.equals(feePayer)).toBe(true);
        }
      }
    }
  });
});

describe("PumpFunRail.buildFeeSharesAtLaunchIxs (GATE 0c gating)", () => {
  const protocol = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;

  it("throws FeatureUnavailable while GATE 0c has not passed (default)", async () => {
    const rail = new PumpFunRail(offlineConnection);
    await expect(
      rail.buildFeeSharesAtLaunchIxs({
        mint,
        vault,
        protocolTreasury: protocol,
        protocolBps: 1000,
      }),
    ).rejects.toThrow(FeatureUnavailableError);
  });

  it("when enabled, emits shares {vault: 1-bps, protocol: bps} summing to 10000", async () => {
    const rail = new PumpFunRail(offlineConnection, { feeSharesEnabled: true });
    const ixs = await rail.buildFeeSharesAtLaunchIxs({
      mint,
      vault,
      protocolTreasury: protocol,
      protocolBps: 1000,
    });
    expect(ixs.length).toBeGreaterThan(0);
    // The update ix carries the shareholder table; decode via the fees IDL
    // inside the rail's own test hook to avoid coupling to account ordering.
    const shares = await rail.decodeFeeShares(ixs);
    expect(shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: vault.toBase58(), shareBps: 9000 }),
        expect.objectContaining({ address: protocol.toBase58(), shareBps: 1000 }),
      ]),
    );
    expect(shares.reduce((s, x) => s + x.shareBps, 0)).toBe(10_000);
  });

  it("rejects out-of-range bps", async () => {
    const rail = new PumpFunRail(offlineConnection, { feeSharesEnabled: true });
    for (const bad of [0, 10_000, -5, 10_001]) {
      await expect(
        rail.buildFeeSharesAtLaunchIxs({
          mint,
          vault,
          protocolTreasury: protocol,
          protocolBps: bad,
        }),
      ).rejects.toThrow(/protocolBps/);
    }
  });
});
