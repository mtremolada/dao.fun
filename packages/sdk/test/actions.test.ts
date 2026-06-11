/**
 * Spec 6.8 — fixed action menu builders (written before implementation).
 * MVP scope here: `grant` and `burn` — the two actions whose dependencies
 * are fully verified. buyback/provideLiquidity/distribute/setParam land
 * once their (verify) items resolve (PumpSwap pool ixs, merkle distributor
 * ID, param registry). Each builder asserts its bounds and touches no
 * accounts outside the declared set.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { newBondingCurve } from "@pump-fun/pump-sdk";
import { buildBurnIxs, buildBuybackIxs, buildGrantIxs } from "../src/actions";

const vault = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

describe("grant (single transfer <= vault balance)", () => {
  it("builds exactly one SystemProgram transfer from the vault", () => {
    const ixs = buildGrantIxs({
      vault,
      recipient,
      lamports: 1_000_000n,
      vaultBalanceLamports: 2_000_000n,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(recipient)).toBe(true);
    // no accounts outside the declared set
    expect(ix.keys).toHaveLength(2);
  });

  it("rejects amounts exceeding the vault balance or zero", () => {
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 6_000n,
        vaultBalanceLamports: 5_000n,
      }),
    ).toThrow(/exceeds vault balance/);
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 0n,
        vaultBalanceLamports: 5_000n,
      }),
    ).toThrow(/positive/);
  });

  it("rejects grants that would push the vault below the rent floor", () => {
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 4_500n,
        vaultBalanceLamports: 5_000n,
        rentFloorLamports: 890_880n,
      }),
    ).toThrow(/rent floor/);
  });
});

describe("burn (treasury-held tokens only)", () => {
  it("burns from the vault's own ATA with the vault as authority", () => {
    const ixs = buildBurnIxs({
      vault,
      mint,
      amount: 42n,
      vaultTokenBalance: 100n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // burn accounts: [account, mint, authority]
    expect(ix.keys[1]!.pubkey.equals(mint)).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[2]!.isSigner).toBe(true); // vault invoke_signs via Squads
  });

  it("rejects burning more than the treasury holds, or zero", () => {
    expect(() =>
      buildBurnIxs({
        vault,
        mint,
        amount: 101n,
        vaultTokenBalance: 100n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
    ).toThrow(/exceeds treasury balance/);
    expect(() =>
      buildBurnIxs({
        vault,
        mint,
        amount: 0n,
        vaultTokenBalance: 100n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
    ).toThrow(/positive/);
  });
});

describe("buyback (curve venue — the token's own bonding curve, spec 6.8)", () => {
  // Realistic mainnet global params; the curve is freshly derived from them
  // (pump-sdk's own newBondingCurve), so the amount math runs against the
  // same oracle the rail uses.
  const global = {
    initialized: true,
    authority: Keypair.generate().publicKey,
    feeRecipient: Keypair.generate().publicKey,
    initialVirtualTokenReserves: new BN("1073000000000000"),
    initialVirtualSolReserves: new BN("30000000000"),
    initialRealTokenReserves: new BN("793100000000000"),
    tokenTotalSupply: new BN("1000000000000000"),
    feeBasisPoints: new BN(95),
    withdrawAuthority: Keypair.generate().publicKey,
    enableMigrate: true,
    poolMigrationFee: new BN(0),
    creatorFeeBasisPoints: new BN(5),
    feeRecipients: [],
    setCreatorAuthority: Keypair.generate().publicKey,
    adminSetCreatorAuthority: Keypair.generate().publicKey,
    createV2Enabled: true,
    whitelistPda: Keypair.generate().publicKey,
    reservedFeeRecipient: Keypair.generate().publicKey,
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    meteoraConfigKeys: [],
    reservedMeteoraConfigKeys: [],
  } as unknown as Parameters<typeof buildBuybackIxs>[0]["global"];

  function makeBuyback(overrides: Record<string, unknown> = {}) {
    const curve = { ...newBondingCurve(global as never), creator: vault };
    return buildBuybackIxs({
      vault,
      mint,
      solLamports: 100_000_000n,
      vaultBalanceLamports: 1_000_000_000n,
      global,
      bondingCurve: curve,
      bondingCurveAccountInfo: {
        executable: false,
        owner: Keypair.generate().publicKey,
        lamports: 1,
        data: Buffer.alloc(0),
      },
      ...overrides,
    } as Parameters<typeof buildBuybackIxs>[0]);
  }

  it("the vault is the buying user and the ONLY signer of the inner set (custody chain satisfies it)", async () => {
    const ixs = await makeBuyback();
    expect(ixs.length).toBeGreaterThan(0);
    const signers = ixs.flatMap((ix) =>
      ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    );
    expect(new Set(signers)).toEqual(new Set([vault.toBase58()]));
    // v2 mints are Token-2022 (D-004)
    expect(
      ixs.some((ix) =>
        ix.keys.some((k) => k.pubkey.equals(TOKEN_2022_PROGRAM_ID)),
      ),
    ).toBe(true);
  });

  it("does NOT create the vault ATA inside the proposal (pre-created permissionlessly — keeps the execute insert under the size ceiling, D-019)", async () => {
    const ixs = await makeBuyback();
    expect(
      ixs.some((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)),
    ).toBe(false);
  });

  it("bounds: rejects zero spend, spend over balance, and spend that strips the rent floor (D-009)", async () => {
    await expect(makeBuyback({ solLamports: 0n })).rejects.toThrow(/positive/);
    await expect(
      makeBuyback({ solLamports: 2_000_000_000n }),
    ).rejects.toThrow(/exceeds/);
    await expect(
      makeBuyback({
        solLamports: 999_800_000n, // leaves < rent floor after fees headroom
      }),
    ).rejects.toThrow(/rent floor/);
  });
});
