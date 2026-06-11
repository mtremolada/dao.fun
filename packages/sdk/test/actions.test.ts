/**
 * Spec 6.8 — fixed action menu builders (written before implementation).
 * Shipped: grant, burn, buyback (curve venue), buyback (AMM venue,
 * post-graduation) and provideLiquidity on the PumpSwap pool — the pool-ix
 * verify item resolved against @pump-fun/pump-swap-sdk's offline builder.
 * Still blocked: distribute (merkle distributor ID), setParam (param
 * registry). Each builder asserts its bounds and touches no accounts
 * outside the declared set.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { newBondingCurve } from "@pump-fun/pump-sdk";
import {
  buildAmmBuybackIxs,
  buildBurnIxs,
  buildBuybackIxs,
  buildGrantIxs,
  buildProvideLiquidityIxs,
} from "../src/actions";

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


// ---------------------------------------------------------------------------
// AMM venue (post-graduation), STAGED two-leg design (D-022): the vault
// stages funds to the native treasury through the custody chain; the
// treasury acts on the PumpSwap pool via direct legs and returns the
// proceeds to the vault. Synthetic state mirrors a freshly migrated
// canonical pool (~85 SOL quote, ~200M base tokens, 6 decimals).
// ---------------------------------------------------------------------------
const nativeTreasury = Keypair.generate().publicKey;
const POOL_KEY = Keypair.generate().publicKey;
const LP_MINT = Keypair.generate().publicKey;

function makeAmmFixtures() {
  const globalConfig = {
    admin: Keypair.generate().publicKey,
    lpFeeBasisPoints: new BN(20),
    protocolFeeBasisPoints: new BN(5),
    disableFlags: 0,
    protocolFeeRecipients: [Keypair.generate().publicKey],
    coinCreatorFeeBasisPoints: new BN(5),
    adminSetCoinCreatorAuthority: Keypair.generate().publicKey,
    whitelistPda: Keypair.generate().publicKey,
    reservedFeeRecipient: Keypair.generate().publicKey,
    mayhemModeEnabled: false,
    reservedFeeRecipients: [],
    buybackFeeRecipients: [Keypair.generate().publicKey],
    buybackBasisPoints: new BN(0),
  };
  const pool = {
    poolBump: 255,
    index: 0,
    creator: Keypair.generate().publicKey,
    baseMint: mint,
    quoteMint: NATIVE_MINT,
    lpMint: LP_MINT,
    poolBaseTokenAccount: Keypair.generate().publicKey,
    poolQuoteTokenAccount: Keypair.generate().publicKey,
    lpSupply: new BN("4000000000000"),
    coinCreator: vault, // the DAO's token: creator fee continuity (INV-1)
    isMayhemMode: false,
    isCashbackCoin: false,
  };
  const tokenAccountInfo = (owner: PublicKey) => ({
    executable: false,
    owner,
    lamports: 2_039_280,
    data: Buffer.alloc(165),
  });
  return { globalConfig, pool, tokenAccountInfo };
}

const treasuryBaseAta = getAssociatedTokenAddressSync(
  mint,
  nativeTreasury,
  true,
  TOKEN_2022_PROGRAM_ID,
);
const treasuryWsolAta = getAssociatedTokenAddressSync(
  NATIVE_MINT,
  nativeTreasury,
  true,
  TOKEN_PROGRAM_ID,
);
const vaultBaseAta = getAssociatedTokenAddressSync(
  mint,
  vault,
  true,
  TOKEN_2022_PROGRAM_ID,
);

function signersOf(ixs: { keys: { isSigner: boolean; pubkey: PublicKey }[] }[]) {
  return new Set(
    ixs.flatMap((ix) =>
      ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
    ),
  );
}

describe("buyback (AMM venue, staged two-leg — the token's own PumpSwap pool, spec 6.8 / D-022)", () => {
  function makeSwapState(overrides: Record<string, unknown> = {}) {
    const { globalConfig, pool, tokenAccountInfo } = makeAmmFixtures();
    return {
      globalConfig,
      feeConfig: null,
      poolKey: POOL_KEY,
      poolAccountInfo: {
        executable: false,
        owner: Keypair.generate().publicKey,
        lamports: 1,
        data: Buffer.alloc(300), // POOL_ACCOUNT_NEW_SIZE: no extend needed
      },
      pool,
      poolBaseAmount: new BN("200000000000000"),
      poolQuoteAmount: new BN("85000000000"),
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      baseMint: mint,
      baseMintAccount: { supply: 1_000_000_000_000_000n, decimals: 6 },
      user: nativeTreasury,
      userBaseTokenAccount: treasuryBaseAta,
      userQuoteTokenAccount: treasuryWsolAta,
      userBaseAccountInfo: tokenAccountInfo(TOKEN_2022_PROGRAM_ID),
      userQuoteAccountInfo: tokenAccountInfo(TOKEN_PROGRAM_ID),
      ...overrides,
    };
  }

  function makeAmmBuyback(
    params: Record<string, unknown> = {},
    stateOverrides: Record<string, unknown> = {},
  ) {
    return buildAmmBuybackIxs({
      vault,
      nativeTreasury,
      mint,
      solLamports: 100_000_000n,
      vaultBalanceLamports: 1_000_000_000n,
      swapState: makeSwapState(stateOverrides),
      ...params,
    } as Parameters<typeof buildAmmBuybackIxs>[0]);
  }

  it("the vault leg stages exactly maxQuote to the native treasury, vault-signed only", async () => {
    const { vaultIxs } = await makeAmmBuyback();
    expect(vaultIxs).toHaveLength(1);
    const ix = vaultIxs[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(nativeTreasury)).toBe(true);
    expect(ix.data.readBigUInt64LE(4)).toBe(105_000_000n); // default 5% slippage
    expect(signersOf(vaultIxs)).toEqual(new Set([vault.toBase58()]));
  });

  it("the treasury leg is treasury-signed only, buys from the DAO's own pool, and ends by returning the bought tokens to the vault's ATA", async () => {
    const { treasuryIxs } = await makeAmmBuyback();
    expect(signersOf(treasuryIxs)).toEqual(new Set([nativeTreasury.toBase58()]));
    expect(
      treasuryIxs.some((ix) => ix.keys.some((k) => k.pubkey.equals(POOL_KEY))),
    ).toBe(true);
    // last ix: SPL transfer treasury base ATA -> vault base ATA
    const back = treasuryIxs[treasuryIxs.length - 1]!;
    expect(back.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(back.keys[0]!.pubkey.equals(treasuryBaseAta)).toBe(true);
    expect(back.keys[1]!.pubkey.equals(vaultBaseAta)).toBe(true);
    expect(back.keys[2]!.pubkey.equals(nativeTreasury)).toBe(true);
  });

  it("does NOT create ATAs inside the proposal — requires them pre-created (D-019 size ceiling)", async () => {
    const { vaultIxs, treasuryIxs } = await makeAmmBuyback();
    expect(
      [...vaultIxs, ...treasuryIxs].some((ix) =>
        ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
      ),
    ).toBe(false);
    await expect(
      makeAmmBuyback({}, { userQuoteAccountInfo: null }),
    ).rejects.toThrow(/pre-created/);
    await expect(
      makeAmmBuyback({}, { userBaseAccountInfo: null }),
    ).rejects.toThrow(/pre-created/);
  });

  it("bounds: rejects zero, over-balance, rent-floor strip (D-009), a foreign pool, and a state whose user is not the native treasury", async () => {
    await expect(makeAmmBuyback({ solLamports: 0n })).rejects.toThrow(
      /positive/,
    );
    await expect(
      makeAmmBuyback({ solLamports: 2_000_000_000n }),
    ).rejects.toThrow(/exceeds/);
    await expect(
      makeAmmBuyback({ solLamports: 999_000_000n }), // maxQuote > balance - floor
    ).rejects.toThrow(/rent floor/);
    const { pool } = makeAmmFixtures();
    await expect(
      makeAmmBuyback(
        {},
        { pool: { ...pool, baseMint: Keypair.generate().publicKey } },
      ),
    ).rejects.toThrow(/own pool/);
    await expect(makeAmmBuyback({}, { user: vault })).rejects.toThrow(
      /native treasury/,
    );
  });
});

describe("provideLiquidity (staged two-leg — the token's own PumpSwap pool, spec 6.8 / D-022)", () => {
  const treasuryLpAta = getAssociatedTokenAddressSync(
    LP_MINT,
    nativeTreasury,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const vaultLpAta = getAssociatedTokenAddressSync(
    LP_MINT,
    vault,
    true,
    TOKEN_2022_PROGRAM_ID,
  );

  function makeLiquidityState(overrides: Record<string, unknown> = {}) {
    const { globalConfig, pool, tokenAccountInfo } = makeAmmFixtures();
    return {
      globalConfig,
      poolKey: POOL_KEY,
      poolAccountInfo: {
        executable: false,
        owner: Keypair.generate().publicKey,
        lamports: 1,
        data: Buffer.alloc(300),
      },
      pool,
      poolBaseTokenAccount: { amount: 200_000_000_000_000n },
      poolQuoteTokenAccount: { amount: 85_000_000_000n },
      baseTokenProgram: TOKEN_2022_PROGRAM_ID,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      user: nativeTreasury,
      userBaseTokenAccount: treasuryBaseAta,
      userQuoteTokenAccount: treasuryWsolAta,
      userPoolTokenAccount: treasuryLpAta,
      userBaseAccountInfo: tokenAccountInfo(TOKEN_2022_PROGRAM_ID),
      userQuoteAccountInfo: tokenAccountInfo(TOKEN_PROGRAM_ID),
      userPoolAccountInfo: tokenAccountInfo(TOKEN_2022_PROGRAM_ID),
      ...overrides,
    };
  }

  function makeProvide(
    params: Record<string, unknown> = {},
    stateOverrides: Record<string, unknown> = {},
  ) {
    return buildProvideLiquidityIxs({
      vault,
      nativeTreasury,
      mint,
      quoteLamports: 100_000_000n,
      vaultBalanceLamports: 1_000_000_000n,
      vaultBaseTokenBalance: 1_000_000_000_000n,
      liquidityState: makeLiquidityState(stateOverrides),
      ...params,
    } as Parameters<typeof buildProvideLiquidityIxs>[0]);
  }

  it("the vault leg stages maxQuote SOL AND maxBase tokens to the treasury, vault-signed only", async () => {
    const { vaultIxs } = await makeProvide();
    expect(vaultIxs).toHaveLength(2);
    const [sol, base] = vaultIxs;
    expect(sol!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(sol!.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(sol!.keys[1]!.pubkey.equals(nativeTreasury)).toBe(true);
    expect(base!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(base!.keys[0]!.pubkey.equals(vaultBaseAta)).toBe(true);
    expect(base!.keys[1]!.pubkey.equals(treasuryBaseAta)).toBe(true);
    expect(base!.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(signersOf(vaultIxs)).toEqual(new Set([vault.toBase58()]));
  });

  it("the treasury leg deposits and ends by returning the LP tokens (exact-lp-out) to the vault's LP ATA, treasury-signed only", async () => {
    const { treasuryIxs } = await makeProvide();
    expect(signersOf(treasuryIxs)).toEqual(new Set([nativeTreasury.toBase58()]));
    expect(
      treasuryIxs.some((ix) => ix.keys.some((k) => k.pubkey.equals(POOL_KEY))),
    ).toBe(true);
    const back = treasuryIxs[treasuryIxs.length - 1]!;
    expect(back.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(back.keys[0]!.pubkey.equals(treasuryLpAta)).toBe(true);
    expect(back.keys[1]!.pubkey.equals(vaultLpAta)).toBe(true);
    expect(back.keys[2]!.pubkey.equals(nativeTreasury)).toBe(true);
  });

  it("does NOT create ATAs inside the proposal — the LP token ATA must be pre-created too (D-019)", async () => {
    const { vaultIxs, treasuryIxs } = await makeProvide();
    expect(
      [...vaultIxs, ...treasuryIxs].some((ix) =>
        ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
      ),
    ).toBe(false);
    await expect(
      makeProvide({}, { userPoolAccountInfo: null }),
    ).rejects.toThrow(/pre-created/);
  });

  it("bounds: rejects zero, rent-floor strip (D-009), more base than the treasury holds, foreign pools, and a non-treasury user", async () => {
    await expect(makeProvide({ quoteLamports: 0n })).rejects.toThrow(
      /positive/,
    );
    await expect(
      makeProvide({ quoteLamports: 999_000_000n }),
    ).rejects.toThrow(/rent floor/);
    await expect(
      makeProvide({ vaultBaseTokenBalance: 1_000n }),
    ).rejects.toThrow(/base/);
    const { pool } = makeAmmFixtures();
    await expect(
      makeProvide(
        {},
        { pool: { ...pool, baseMint: Keypair.generate().publicKey } },
      ),
    ).rejects.toThrow(/own pool/);
    await expect(makeProvide({}, { user: vault })).rejects.toThrow(
      /native treasury/,
    );
  });
});
