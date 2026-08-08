/**
 * Shared client for the launchpad suites — instruction builders, PDAs and
 * account decoders for `programs/launchpad-curve`.
 *
 * Hand-rolled, like every other client in this repo: discriminators from
 * sha256("global:<ix>"), raw TransactionInstructions, state read by byte
 * offset. No anchor TS client anywhere, so a layout change shows up as a
 * failing offset rather than being silently absorbed by a regenerated IDL.
 *
 * Rebuild the program fixture (toolchain in DECISIONS.md D-035):
 *   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
 *   export CARGO_NET_GIT_FETCH_WITH_CLI=true
 *   cargo-build-sbf --manifest-path programs/launchpad-curve/Cargo.toml
 *   gzip -9 -c programs/target/deploy/launchpad_curve.so \
 *     > tests/fixtures/launchpad_curve.so.gz
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { AddedAccount, ProgramTestContext } from "solana-bankrun";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_AMM_CONFIG,
  RAYDIUM_CPMM_AUTHORITY,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../../packages/sdk/src/constants";
import type { CurveParams } from "../../packages/sdk/src/curve-math";
import { startCtx } from "./bankrun-harness";

/** Scaffold id; the real one is minted at the first devnet deploy. */
export const LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr",
);

const FIXTURES = resolve(__dirname, "..", "fixtures");

export const disc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

const pda = (seeds: (Buffer | Uint8Array)[], programId = LAUNCHPAD_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const configPda = () => pda([Buffer.from("config")]);
export const curvePda = (mint: PublicKey) =>
  pda([Buffer.from("bonding-curve"), mint.toBuffer()]);
export const solVaultPda = (mint: PublicKey) =>
  pda([Buffer.from("sol-vault"), mint.toBuffer()]);
export const creatorVaultPda = (creator: PublicKey) =>
  pda([Buffer.from("creator-vault"), creator.toBuffer()]);
export const migrationAuthorityPda = (mint: PublicKey) =>
  pda([Buffer.from("migration-authority"), mint.toBuffer()]);
export const poolStatePda = (mint: PublicKey) =>
  pda([Buffer.from("cpmm-pool"), mint.toBuffer()]);

/** anchor's `#[event_cpi]` appends these two accounts to every context. */
const eventAuthorityPda = () =>
  pda([Buffer.from("__event_authority")]);

export const metadataPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      MPL_TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    MPL_TOKEN_METADATA_PROGRAM_ID,
  )[0];

/** Raydium's derived accounts, all keyed off whichever pool account we use. */
export function cpmmPoolAccounts(mint: PublicKey) {
  const poolState = poolStatePda(mint);
  const ray = (seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, RAYDIUM_CPMM_PROGRAM_ID)[0];
  const wsolIsToken0 =
    Buffer.compare(NATIVE_MINT.toBuffer(), mint.toBuffer()) < 0;
  const [mint0, mint1] = wsolIsToken0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  const lpMint = ray([Buffer.from("pool_lp_mint"), poolState.toBuffer()]);
  return {
    poolState,
    wsolIsToken0,
    mint0,
    mint1,
    lpMint,
    vault0: ray([
      Buffer.from("pool_vault"),
      poolState.toBuffer(),
      mint0.toBuffer(),
    ]),
    vault1: ray([
      Buffer.from("pool_vault"),
      poolState.toBuffer(),
      mint1.toBuffer(),
    ]),
    observation: ray([Buffer.from("observation"), poolState.toBuffer()]),
    migrationLp: getAssociatedTokenAddressSync(
      lpMint,
      migrationAuthorityPda(mint),
      true,
    ),
  };
}

export function cpmmFixtureAccounts(): AddedAccount[] {
  return (
    JSON.parse(
      readFileSync(join(FIXTURES, "cpmm-accounts.json"), "utf8"),
    ) as { address: string; owner: string; lamports: number; dataBase64: string }[]
  ).map((a) => ({
    address: new PublicKey(a.address),
    info: {
      lamports: a.lamports,
      data: Buffer.from(a.dataBase64, "base64"),
      owner: new PublicKey(a.owner),
      executable: false,
    },
  }));
}

/** bankrun with our program plus the real Raydium and Metaplex binaries. */
export function startLaunchpadCtx(): Promise<ProgramTestContext> {
  return startCtx(
    [
      { name: "launchpad_curve", programId: LAUNCHPAD_PROGRAM_ID },
      { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
      { name: "mpl_token_metadata", programId: MPL_TOKEN_METADATA_PROGRAM_ID },
    ],
    cpmmFixtureAccounts(),
  );
}

function encodeConfigParams(p: CurveParams & { graduationFeeLamports?: bigint }) {
  const data = Buffer.alloc(2 + 2 + 8 * 5);
  let o = 0;
  data.writeUInt16LE(p.protocolFeeBps, o); o += 2;
  data.writeUInt16LE(p.creatorFeeBps, o); o += 2;
  data.writeBigUInt64LE(p.graduationFeeLamports ?? 0n, o); o += 8;
  data.writeBigUInt64LE(p.initialVirtualSol, o); o += 8;
  data.writeBigUInt64LE(p.initialVirtualToken, o); o += 8;
  data.writeBigUInt64LE(p.initialRealToken, o); o += 8;
  data.writeBigUInt64LE(p.tokenTotalSupply, o);
  return data;
}

export type ConfigInput = CurveParams & { graduationFeeLamports?: bigint };

export function initializeConfigIx(args: {
  payer: PublicKey;
  authority: PublicKey;
  feeRecipient: PublicKey;
  params: ConfigInput;
  ammConfig?: PublicKey;
  createPoolFee?: PublicKey;
  cpmmProgram?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: Buffer.concat([
      disc("initialize_config"),
      encodeConfigParams(args.params),
    ]),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.feeRecipient, isSigner: false, isWritable: false },
      {
        pubkey: args.cpmmProgram ?? RAYDIUM_CPMM_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: args.ammConfig ?? RAYDIUM_CPMM_AMM_CONFIG,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: args.createPoolFee ?? RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

export function updateConfigIx(args: {
  authority: PublicKey;
  params: ConfigInput;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: Buffer.concat([disc("update_config"), encodeConfigParams(args.params)]),
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: configPda(), isSigner: false, isWritable: true },
    ],
  });
}

const borshString = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

const eventCpiKeys = () => [
  { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
  { pubkey: LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
];

export function createCoinIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  name?: string;
  symbol?: string;
  uri?: string;
}): TransactionInstruction {
  const curve = curvePda(args.mint);
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: Buffer.concat([
      disc("create_coin"),
      borshString(args.name ?? "Test Coin"),
      borshString(args.symbol ?? "TEST"),
      borshString(args.uri ?? "https://example.invalid/meta.json"),
      args.creator.toBuffer(),
    ]),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: true, isWritable: true },
      { pubkey: curve, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(args.mint, curve, true),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: solVaultPda(args.mint), isSigner: false, isWritable: true },
      {
        pubkey: creatorVaultPda(args.creator),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: metadataPda(args.mint), isSigner: false, isWritable: true },
      {
        pubkey: MPL_TOKEN_METADATA_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      {
        pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ...eventCpiKeys(),
    ],
  });
}

function tradeKeys(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  feeRecipient: PublicKey;
}) {
  const curve = curvePda(args.mint);
  return [
    { pubkey: args.user, isSigner: true, isWritable: true },
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: args.mint, isSigner: false, isWritable: false },
    { pubkey: curve, isSigner: false, isWritable: true },
    {
      pubkey: getAssociatedTokenAddressSync(args.mint, curve, true),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: solVaultPda(args.mint), isSigner: false, isWritable: true },
    {
      pubkey: getAssociatedTokenAddressSync(args.mint, args.user, true),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: args.feeRecipient, isSigner: false, isWritable: true },
    {
      pubkey: creatorVaultPda(args.creator),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...eventCpiKeys(),
  ];
}

export function buyIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  feeRecipient: PublicKey;
  tokenAmount: bigint;
  maxSolCost: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(args.tokenAmount, 0);
  data.writeBigUInt64LE(args.maxSolCost, 8);
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: Buffer.concat([disc("buy"), data]),
    keys: tradeKeys(args),
  });
}

export function sellIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  feeRecipient: PublicKey;
  tokenAmount: bigint;
  minSolOutput: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(args.tokenAmount, 0);
  data.writeBigUInt64LE(args.minSolOutput, 8);
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: Buffer.concat([disc("sell"), data]),
    keys: tradeKeys(args),
  });
}

export function migrateIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
  ammConfig?: PublicKey;
  createPoolFee?: PublicKey;
  cpmmProgram?: PublicKey;
  poolStateOverride?: PublicKey;
}): TransactionInstruction {
  const curve = curvePda(args.mint);
  const migration = migrationAuthorityPda(args.mint);
  const p = cpmmPoolAccounts(args.mint);
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: disc("migrate"),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: configPda(), isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(args.mint, curve, true),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: solVaultPda(args.mint), isSigner: false, isWritable: true },
      { pubkey: migration, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(NATIVE_MINT, migration, true),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: getAssociatedTokenAddressSync(args.mint, migration, true),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.migrationLp, isSigner: false, isWritable: true },
      { pubkey: NATIVE_MINT, isSigner: false, isWritable: false },
      { pubkey: args.feeRecipient, isSigner: false, isWritable: true },
      {
        pubkey: args.cpmmProgram ?? RAYDIUM_CPMM_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: RAYDIUM_CPMM_AUTHORITY, isSigner: false, isWritable: false },
      {
        pubkey: args.ammConfig ?? RAYDIUM_CPMM_AMM_CONFIG,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: args.createPoolFee ?? RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: args.poolStateOverride ?? p.poolState,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.lpMint, isSigner: false, isWritable: true },
      { pubkey: p.vault0, isSigner: false, isWritable: true },
      { pubkey: p.vault1, isSigner: false, isWritable: true },
      { pubkey: p.observation, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ...eventCpiKeys(),
    ],
  });
}

export function collectCreatorFeeIx(args: {
  payer: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data: disc("collect_creator_fee"),
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.creator, isSigner: false, isWritable: true },
      { pubkey: curvePda(args.mint), isSigner: false, isWritable: false },
      {
        pubkey: creatorVaultPda(args.creator),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

// ---------- decoders (byte offsets, deliberately) ----------

export interface DecodedCurve {
  mint: PublicKey;
  creator: PublicKey;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  protocolFeeBps: number;
  creatorFeeBps: number;
  complete: boolean;
  migrated: boolean;
  poolState: PublicKey;
}

export async function readCurve(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<DecodedCurve> {
  const info = await ctx.banksClient.getAccount(curvePda(mint));
  if (!info) throw new Error("bonding curve account missing");
  const d = Buffer.from(info.data);
  return {
    mint: new PublicKey(d.subarray(8, 40)),
    creator: new PublicKey(d.subarray(40, 72)),
    virtualSol: d.readBigUInt64LE(72),
    virtualToken: d.readBigUInt64LE(80),
    realSol: d.readBigUInt64LE(88),
    realToken: d.readBigUInt64LE(96),
    protocolFeeBps: d.readUInt16LE(104),
    creatorFeeBps: d.readUInt16LE(106),
    complete: d[108] === 1,
    migrated: d[109] === 1,
    poolState: new PublicKey(d.subarray(110, 142)),
  };
}

export async function tokenBalance(
  ctx: ProgramTestContext,
  account: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(account);
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

export async function mintSupply(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(mint);
  if (!info) throw new Error("mint missing");
  return Buffer.from(info.data).readBigUInt64LE(36);
}

/** SPL mint layout: COption<Pubkey> authority at 0, freeze at 46. */
export async function mintAuthorities(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<{ mintAuthority: boolean; freezeAuthority: boolean }> {
  const info = await ctx.banksClient.getAccount(mint);
  if (!info) throw new Error("mint missing");
  const d = Buffer.from(info.data);
  return {
    mintAuthority: d.readUInt32LE(0) === 1,
    freezeAuthority: d.readUInt32LE(46) === 1,
  };
}

/**
 * Grinds a mint keypair that sorts on the requested side of wSOL. WSOL's
 * first byte is 6, so "below" is ~2.3% of the keyspace — a few dozen tries.
 * Both branches matter: the WSOL-as-token_1 path is the one almost nobody
 * exercises in production.
 */
export function grindMint(below: boolean): Keypair {
  for (let i = 0; i < 20_000; i += 1) {
    const kp = Keypair.generate();
    const isBelow =
      Buffer.compare(kp.publicKey.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
    if (isBelow === below) return kp;
  }
  throw new Error(`could not grind a mint sorting ${below ? "below" : "above"} wSOL`);
}
