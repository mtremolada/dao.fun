/**
 * Spec 6.8 — fixed action menu builders (written before implementation).
 * Shipped: grant, burn, buyback (curve venue), buyback (AMM venue,
 * post-graduation), provideLiquidity on the PumpSwap pool — the pool-ix
 * verify item resolved against @pump-fun/pump-swap-sdk's offline builder —
 * and distribute on the Jito merkle distributor (D-024). Still blocked:
 * setParam (param registry, Stage 3). Each builder asserts its bounds and
 * touches no accounts outside the declared set.
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
  GovernanceConfig,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
} from "@solana/spl-governance";
import {
  buildAmmBuybackIxs,
  buildBurnIxs,
  buildBuybackIxs,
  buildDistributeIxs,
  buildGrantIxs,
  buildProvideLiquidityIxs,
  buildSetParamIxs,
} from "../src/actions";
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from "../src/constants";
import { verifyClaimProof } from "../src/merkle-distributor";

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
      // the vault's pre-created token ATA (non-null -> no ATA-create ix)
      userTokenAccountInfo: {
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

describe("distribute (merkle claim distributor, spec 6.8 / D-024)", () => {
  const shares = [
    { claimant: Keypair.generate().publicKey, lamports: 300_000_000n },
    { claimant: Keypair.generate().publicKey, lamports: 200_000_000n },
    { claimant: Keypair.generate().publicKey, lamports: 100_000_000n },
  ];
  const NOW = 1_800_000_000n;
  const base = {
    vault,
    shares,
    version: 42n,
    startVestingTs: NOW + 60n,
    endVestingTs: NOW + 120n,
    clawbackStartTs: NOW + 120n + 86_400n,
    vaultBalanceLamports: 2_000_000_000n,
  };

  it("one proposal: newDistributor (vault = admin/only inner signer) + fund + sync", () => {
    const built = buildDistributeIxs(base);
    expect(built.ixs).toHaveLength(3);
    const [create, fund, sync] = built.ixs;
    expect(create!.programId.equals(MERKLE_DISTRIBUTOR_PROGRAM_ID)).toBe(true);
    // the vault is the ONLY signer across all legs (custody chain provides it)
    for (const ix of built.ixs) {
      for (const meta of ix.keys) {
        if (meta.isSigner) expect(meta.pubkey.equals(vault)).toBe(true);
      }
    }
    // funding: exactly the share total, vault -> distributor token vault
    expect(fund!.programId.equals(SystemProgram.programId)).toBe(true);
    expect(fund!.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(fund!.keys[1]!.pubkey.equals(built.tokenVault)).toBe(true);
    expect(fund!.data.readBigUInt64LE(4)).toBe(600_000_000n);
    expect(built.totalLamports).toBe(600_000_000n);
    // the sync makes the wrapped funding visible to the token program
    expect(sync!.keys[0]!.pubkey.equals(built.tokenVault)).toBe(true);
    // clawback returns to VAULT custody (its WSOL ATA)
    expect(
      built.clawbackReceiver.equals(
        getAssociatedTokenAddressSync(NATIVE_MINT, vault, true),
      ),
    ).toBe(true);
  });

  it("no accounts outside the declared set; every share proof verifies against the pinned root", () => {
    const built = buildDistributeIxs(base);
    const declared = new Set(
      [
        built.distributor,
        built.tokenVault,
        built.clawbackReceiver,
        vault,
        NATIVE_MINT,
        SystemProgram.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
      ].map((k) => k.toBase58()),
    );
    for (const ix of built.ixs) {
      for (const meta of ix.keys) {
        expect(declared.has(meta.pubkey.toBase58())).toBe(true);
      }
    }
    for (const s of shares) {
      expect(
        verifyClaimProof(
          built.tree.root,
          s.claimant,
          s.lamports,
          built.tree.proofFor(s.claimant),
        ),
      ).toBe(true);
    }
  });

  it("rejects totals exceeding the balance and rent-floor/rent-budget breaches (D-009)", () => {
    expect(() =>
      buildDistributeIxs({ ...base, vaultBalanceLamports: 500_000_000n }),
    ).toThrow(/exceeds vault balance/);
    // total fits, but floor + distributor rent budget would be invaded
    expect(() =>
      buildDistributeIxs({ ...base, vaultBalanceLamports: 601_000_000n }),
    ).toThrow(/rent floor/);
  });

  it("mirrors the program's timing constraints at build time", () => {
    expect(() =>
      buildDistributeIxs({ ...base, startVestingTs: base.endVestingTs }),
    ).toThrow(/precede/);
    expect(() =>
      buildDistributeIxs({
        ...base,
        clawbackStartTs: base.endVestingTs + 86_399n,
      }),
    ).toThrow(/one day/);
  });

  it("rejects empty and duplicate share sets", () => {
    expect(() => buildDistributeIxs({ ...base, shares: [] })).toThrow(
      /non-empty/,
    );
    expect(() =>
      buildDistributeIxs({
        ...base,
        shares: [shares[0]!, shares[0]!],
      }),
    ).toThrow(/duplicate/);
  });
});

describe("setParam (whitelisted-param registry, spec 6.8 / D-025)", () => {
  const governance = Keypair.generate().publicKey;
  const SUPPLY = 200_000_000_000n;

  function currentConfig() {
    return new GovernanceConfig({
      communityVoteThreshold: new VoteThreshold({
        type: VoteThresholdType.YesVotePercentage,
        value: 25,
      }),
      minCommunityTokensToCreateProposal: new BN("4000000000"),
      minInstructionHoldUpTime: 72 * 3600,
      baseVotingTime: 3 * 86400,
      communityVoteTipping: VoteTipping.Disabled,
      minCouncilTokensToCreateProposal: new BN(1),
      councilVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled }),
      councilVetoVoteThreshold: new VoteThreshold({
        type: VoteThresholdType.YesVotePercentage,
        value: 50,
      }),
      communityVetoVoteThreshold: new VoteThreshold({
        type: VoteThresholdType.Disabled,
      }),
      councilVoteTipping: VoteTipping.Strict,
      votingCoolOffTime: 0,
      depositExemptProposalCount: 10,
    });
  }

  it("builds ONE direct leg whose only account is the governance PDA as writable signer", () => {
    const r = buildSetParamIxs({
      governance,
      currentConfig: currentConfig(),
      mode: "council",
      tier: "micro",
      communitySupply: SUPPLY,
      paramId: "holdUpSeconds",
      value: BigInt(96 * 3600),
    });
    expect(r.directIxs).toHaveLength(1);
    const ix = r.directIxs[0]!;
    // no accounts outside the declared set — and the vault is NOWHERE
    expect(ix.keys).toHaveLength(1);
    expect(ix.keys[0]!.pubkey.equals(governance)).toBe(true);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
    expect(r.newConfig.minInstructionHoldUpTime).toBe(96 * 3600);
  });

  it("ratchet by omission: every non-target field is preserved verbatim", () => {
    const cur = currentConfig();
    const r = buildSetParamIxs({
      governance,
      currentConfig: cur,
      mode: "council",
      tier: "micro",
      communitySupply: SUPPLY,
      paramId: "quorumPercent",
      value: 30n,
    });
    const next = r.newConfig;
    expect(next.communityVoteThreshold.value).toBe(30);
    // the veto surface (mode-structural) is untouchable through setParam
    expect(next.councilVetoVoteThreshold.type).toBe(cur.councilVetoVoteThreshold.type);
    expect(next.councilVetoVoteThreshold.value).toBe(cur.councilVetoVoteThreshold.value);
    expect(next.communityVetoVoteThreshold.type).toBe(
      cur.communityVetoVoteThreshold.type,
    );
    // the exit window (tipping Disabled) and anti-spam settings survive too
    expect(next.communityVoteTipping).toBe(cur.communityVoteTipping);
    expect(next.councilVoteTipping).toBe(cur.councilVoteTipping);
    expect(next.votingCoolOffTime).toBe(cur.votingCoolOffTime);
    expect(next.depositExemptProposalCount).toBe(cur.depositExemptProposalCount);
    expect(next.minInstructionHoldUpTime).toBe(cur.minInstructionHoldUpTime);
    expect(next.baseVotingTime).toBe(cur.baseVotingTime);
    expect(
      next.minCommunityTokensToCreateProposal.eq(
        cur.minCommunityTokensToCreateProposal,
      ),
    ).toBe(true);
  });

  it("hold-up floors are mode-resolved: council=floor, cypherpunk=max(24h,floor), sovereign=0", () => {
    const build = (mode: "council" | "cypherpunk" | "sovereign", tier: "micro" | "large", v: bigint) =>
      buildSetParamIxs({
        governance,
        currentConfig: currentConfig(),
        mode,
        tier,
        communitySupply: SUPPLY,
        paramId: "holdUpSeconds",
        value: v,
      });
    expect(() => build("council", "micro", BigInt(71 * 3600))).toThrow(/INV-3/);
    expect(() => build("cypherpunk", "micro", BigInt(71 * 3600))).toThrow(/INV-3/);
    // large tier floor is 24h; cypherpunk keeps max(24h, floor) == 24h
    expect(build("council", "large", BigInt(24 * 3600)).newConfig.minInstructionHoldUpTime).toBe(24 * 3600);
    expect(build("cypherpunk", "large", BigInt(24 * 3600)).newConfig.minInstructionHoldUpTime).toBe(24 * 3600);
    // sovereign chose floor exemption at launch (double-confirmed)
    expect(build("sovereign", "micro", 0n).newConfig.minInstructionHoldUpTime).toBe(0);
  });

  it("quorum and proposal-threshold floors bind; baseVotingTime has the program minimum", () => {
    const build = (paramId: "quorumPercent" | "proposalThresholdTokens" | "baseVotingTime", v: bigint) =>
      buildSetParamIxs({
        governance,
        currentConfig: currentConfig(),
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId,
        value: v,
      });
    expect(() => build("quorumPercent", 24n)).toThrow(/within \[25, 100\]/);
    expect(() => build("quorumPercent", 101n)).toThrow(/within \[25, 100\]/);
    expect(build("quorumPercent", 25n).newConfig.communityVoteThreshold.value).toBe(25);
    // micro floor: 200 bps of 200e9 == 4e9
    expect(() => build("proposalThresholdTokens", 3_999_999_999n)).toThrow(/bps of supply/);
    expect(
      build("proposalThresholdTokens", 5_000_000_000n).newConfig
        .minCommunityTokensToCreateProposal.toString(),
    ).toBe("5000000000");
    expect(() => build("baseVotingTime", 3599n)).toThrow(/program minimum/);
    expect(build("baseVotingTime", 86_400n).newConfig.baseVotingTime).toBe(86_400);
  });

  it("anything off the whitelist is refused at build time", () => {
    expect(() =>
      buildSetParamIxs({
        governance,
        currentConfig: currentConfig(),
        mode: "council",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId: "councilVetoVoteThreshold" as never,
        value: 1n,
      }),
    ).toThrow(/not a whitelisted param/);
  });
});
