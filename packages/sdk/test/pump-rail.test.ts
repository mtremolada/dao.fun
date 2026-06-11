/**
 * Spec 6.1 — PumpFunRail tests (written before implementation).
 * Unit-level: no network. On-chain vault check happens in the Stage 1
 * integration suite; here the installed pump-sdk + IDL act as oracles.
 */
import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BorshInstructionCoder } from "@coral-xyz/anchor";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PumpSdk,
  ammCreatorVaultPda,
  creatorVaultPda,
  feeSharingConfigPda,
  pumpIdl,
} from "@pump-fun/pump-sdk";
import { PUMP_AMM_PROGRAM_ID } from "../src/constants";
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

// ---- AMM venue (spec 6.5): post-graduation creator fees accrue as WSOL in
// the AMM creator-vault ATA. The keeper consolidates them into the CURVE
// creator vault (native SOL) via transfer_creator_fees_to_pump_v2, then the
// ordinary curve collect sweeps everything — the DAO never holds WSOL.

/** Spendable WSOL ATA for the AMM creator-vault authority of `creator`. */
function ammVaultAtaOf(creator: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    NATIVE_MINT,
    ammCreatorVaultPda(creator),
    true,
    TOKEN_PROGRAM_ID,
  );
}

/** Minimal packed WSOL token account, as getMultipleAccountsInfo returns it. */
function wsolAccountInfo(owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: NATIVE_MINT,
      owner,
      amount,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 1,
      isNative: 2_039_280n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return {
    executable: false,
    owner: TOKEN_PROGRAM_ID,
    lamports: 2_039_280 + Number(amount),
    data,
  };
}

/** Connection stub answering getMultipleAccountsInfo from a fixed map. */
function connectionWith(accounts: Map<string, ReturnType<typeof wsolAccountInfo>>) {
  return {
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) => accounts.get(k.toBase58()) ?? null),
  } as unknown as Connection;
}

describe("PumpFunRail.buildConsolidateAmmFeesIx (spec 6.5)", () => {
  const rail = new PumpFunRail(offlineConnection);
  const payer = Keypair.generate().publicKey;

  it("byte-identical to the pump-sdk's own builder (oracle: sharing-config creator)", async () => {
    // The sdk only exposes the instruction with the fee-sharing-config PDA
    // as coinCreator; for that creator the two builds must coincide exactly.
    const mint = Keypair.generate().publicKey;
    const cfg = feeSharingConfigPda(mint);
    const ours = await rail.buildConsolidateAmmFeesIx(cfg, payer);
    const theirs = await new PumpSdk().transferCreatorFeesToPumpV2({
      payer,
      mint,
      quoteMint: NATIVE_MINT,
    });
    expect(ours.programId.equals(theirs.programId)).toBe(true);
    expect(ours.data.equals(theirs.data)).toBe(true);
    expect(ours.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual(
      theirs.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
    );
  });

  it("INV-2: the payer is the only signer; the creator never signs", async () => {
    const creator = Keypair.generate().publicKey; // the Squads vault PDA
    const ix = await rail.buildConsolidateAmmFeesIx(creator, payer);
    for (const meta of ix.keys) {
      if (meta.isSigner) expect(meta.pubkey.equals(payer)).toBe(true);
      if (meta.pubkey.equals(creator)) expect(meta.isSigner).toBe(false);
    }
  });

  it("executes on the AMM program and credits the CURVE creator vault", async () => {
    const creator = Keypair.generate().publicKey;
    const ix = await rail.buildConsolidateAmmFeesIx(creator, payer);
    expect(ix.programId.equals(PUMP_AMM_PROGRAM_ID)).toBe(true);
    const source = ix.keys.find((k) => k.pubkey.equals(ammVaultAtaOf(creator)));
    const dest = ix.keys.find((k) => k.pubkey.equals(creatorVaultPda(creator)));
    expect(source?.isWritable).toBe(true);
    expect(dest?.isWritable).toBe(true);
  });
});

describe("PumpFunRail.buildCollectFeesIxs venue composition (spec 6.5)", () => {
  const creator = Keypair.generate().publicKey;
  const feePayer = Keypair.generate().publicKey;

  function curveVaultTouched(ix: TransactionInstruction): boolean {
    return ix.keys.some((k) => k.pubkey.equals(creatorVaultPda(creator)));
  }

  it("curve-only when no AMM vault ATA exists: one collect ix, zero signers", async () => {
    const rail = new PumpFunRail(connectionWith(new Map()));
    const ixs = await rail.buildCollectFeesIxs(creator, feePayer);
    expect(ixs).toHaveLength(1);
    expect(curveVaultTouched(ixs[0]!)).toBe(true);
    expect(ixs[0]!.keys.every((k) => !k.isSigner)).toBe(true);
  });

  it("consolidates BEFORE collecting when AMM WSOL has accrued", async () => {
    const ata = ammVaultAtaOf(creator);
    const rail = new PumpFunRail(
      connectionWith(new Map([[ata.toBase58(), wsolAccountInfo(ammCreatorVaultPda(creator), 5_000n)]])),
    );
    const ixs = await rail.buildCollectFeesIxs(creator, feePayer);
    expect(ixs).toHaveLength(2);
    expect(ixs[0]!.programId.equals(PUMP_AMM_PROGRAM_ID)).toBe(true);
    expect(curveVaultTouched(ixs[1]!)).toBe(true);
    // the whole pair still only ever needs the keeper's signature
    for (const ix of ixs) {
      for (const meta of ix.keys) {
        if (meta.isSigner) expect(meta.pubkey.equals(feePayer)).toBe(true);
      }
    }
  });

  it("an empty AMM vault ATA adds no consolidation leg", async () => {
    const ata = ammVaultAtaOf(creator);
    const rail = new PumpFunRail(
      connectionWith(new Map([[ata.toBase58(), wsolAccountInfo(ammCreatorVaultPda(creator), 0n)]])),
    );
    const ixs = await rail.buildCollectFeesIxs(creator, feePayer);
    expect(ixs).toHaveLength(1);
  });

  it("refuses AMM consolidation without a feePayer (the vault must never sign)", async () => {
    const ata = ammVaultAtaOf(creator);
    const rail = new PumpFunRail(
      connectionWith(new Map([[ata.toBase58(), wsolAccountInfo(ammCreatorVaultPda(creator), 5_000n)]])),
    );
    await expect(rail.buildCollectFeesIxs(creator)).rejects.toThrow(/feePayer/);
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
