/**
 * Hand-rolled launchpad instruction builders — no anchor TS client, so a
 * layout change surfaces as a failing byte offset rather than being absorbed
 * by a regenerated IDL (the house convention).
 *
 * Account orders here are the same ones the on-chain program checks and the
 * bankrun integration suite drives against the real binaries; the test
 * harness delegates to these builders so the two can never drift.
 */
import {
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  type Keypair,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { MPL_TOKEN_METADATA_PROGRAM_ID } from "../constants";
import {
  LAUNCHPAD_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  ixDiscriminator,
  raydiumCpmmAddresses,
  type Cluster,
  type RaydiumCpmmAddresses,
} from "./constants";
import {
  configPda,
  cpmmPoolAccounts,
  creatorVaultPda,
  protocolVaultPda,
  feeAuthorityPda,
  feeNftMintPda,
  graduatedFeesPda,
  lockCpAuthorityPda,
  lockedLiquidityPda,
  curvePda,
  metadataPda,
  migrationAuthorityPda,
  solVaultPda,
} from "./pdas";

const AM = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});

const eventAuthorityPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId)[0];

const eventCpiKeys = (programId: PublicKey) => [
  AM(eventAuthorityPda(programId), false, false),
  AM(programId, false, false),
];

const borshString = (value: string): Buffer => {
  const bytes = Buffer.from(value, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
};

export interface ConfigParamsInput {
  protocolFeeBps: number;
  creatorFeeBps: number;
  graduationFeeLamports?: bigint;
  initialVirtualSol: bigint;
  initialVirtualToken: bigint;
  initialRealToken: bigint;
  tokenTotalSupply: bigint;
}

function encodeConfigParams(p: ConfigParamsInput): Buffer {
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

export function buildInitializeConfigIx(args: {
  payer: PublicKey;
  authority: PublicKey;
  feeRecipient: PublicKey;
  params: ConfigParamsInput;
  cluster: Cluster;
  programId?: PublicKey;
  ray?: RaydiumCpmmAddresses;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const ray = args.ray ?? raydiumCpmmAddresses(args.cluster);
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([
      ixDiscriminator("initialize_config"),
      encodeConfigParams(args.params),
    ]),
    keys: [
      AM(args.payer, true, true),
      AM(args.authority, true, false),
      AM(args.feeRecipient, false, false),
      AM(ray.program, false, false),
      AM(ray.ammConfig, false, false),
      AM(ray.createPoolFeeReceiver, false, false),
      AM(configPda(programId), false, true),
      AM(SystemProgram.programId, false, false),
    ],
  });
}

export function buildUpdateConfigIx(args: {
  authority: PublicKey;
  params: ConfigParamsInput;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([
      ixDiscriminator("update_config"),
      encodeConfigParams(args.params),
    ]),
    keys: [
      AM(args.authority, true, false),
      AM(configPda(programId), false, true),
    ],
  });
}

/**
 * Authority-only: selects the Raydium fee tier new pools are created in,
 * whether migrate locks or burns the LP, and the protocol's share of the
 * resulting stream. Separate from updateConfig because these are graduation
 * parameters, not curve parameters.
 */
export function buildSetGraduationConfigIx(args: {
  authority: PublicKey;
  ammConfig: PublicKey;
  /** PublicKey.default (all zero) keeps the burn branch — devnet's only option. */
  lockProgram: PublicKey;
  graduatedFeeProtocolBps: number;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const data = Buffer.alloc(32 + 2);
  args.lockProgram.toBuffer().copy(data, 0);
  data.writeUInt16LE(args.graduatedFeeProtocolBps, 32);
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([ixDiscriminator("set_graduation_config"), data]),
    keys: [
      AM(args.authority, true, false),
      AM(configPda(programId), false, true),
      AM(args.ammConfig, false, false),
    ],
  });
}

export function buildCreateCoinIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const curve = curvePda(args.mint, programId);
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([
      ixDiscriminator("create_coin"),
      borshString(args.name),
      borshString(args.symbol),
      borshString(args.uri),
      args.creator.toBuffer(),
    ]),
    keys: [
      AM(args.payer, true, true),
      AM(configPda(programId), false, false),
      AM(args.mint, true, true),
      AM(curve, false, true),
      AM(getAssociatedTokenAddressSync(args.mint, curve, true), false, true),
      AM(solVaultPda(args.mint, programId), false, true),
      AM(creatorVaultPda(args.creator, programId), false, true),
      AM(protocolVaultPda(args.mint, programId), false, true),
      AM(metadataPda(args.mint, MPL_TOKEN_METADATA_PROGRAM_ID), false, true),
      AM(MPL_TOKEN_METADATA_PROGRAM_ID, false, false),
      AM(TOKEN_PROGRAM_ID, false, false),
      AM(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      AM(SystemProgram.programId, false, false),
      AM(SYSVAR_RENT_PUBKEY, false, false),
      ...eventCpiKeys(programId),
    ],
  });
}

function tradeKeys(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  programId: PublicKey;
}) {
  const curve = curvePda(args.mint, args.programId);
  return [
    AM(args.user, true, true),
    AM(configPda(args.programId), false, false),
    AM(args.mint, false, false),
    AM(curve, false, true),
    AM(getAssociatedTokenAddressSync(args.mint, curve, true), false, true),
    AM(solVaultPda(args.mint, args.programId), false, true),
    AM(getAssociatedTokenAddressSync(args.mint, args.user, true), false, true),
    AM(protocolVaultPda(args.mint, args.programId), false, true),
    AM(creatorVaultPda(args.creator, args.programId), false, true),
    AM(TOKEN_PROGRAM_ID, false, false),
    AM(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    AM(SystemProgram.programId, false, false),
    ...eventCpiKeys(args.programId),
  ];
}

export function buildBuyIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenAmount: bigint;
  maxSolCost: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(args.tokenAmount, 0);
  data.writeBigUInt64LE(args.maxSolCost, 8);
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([ixDiscriminator("buy"), data]),
    keys: tradeKeys({ ...args, programId }),
  });
}

export function buildSellIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  tokenAmount: bigint;
  minSolOutput: bigint;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(args.tokenAmount, 0);
  data.writeBigUInt64LE(args.minSolOutput, 8);
  return new TransactionInstruction({
    programId,
    data: Buffer.concat([ixDiscriminator("sell"), data]),
    keys: tradeKeys({ ...args, programId }),
  });
}

export function buildMigrateIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
  cluster: Cluster;
  /**
   * The Raydium fee tier to graduate into. The PROGRAM address-checks this
   * against `Config.cpmm_amm_config`, which `set_graduation_config` can move
   * (that is the point — the tier is the DAO's perpetual income rate). Always
   * pass the value decoded from the live Config; the cluster default is only
   * a fallback for callers that have not read it, and it is wrong the moment
   * the tier is changed.
   */
  ammConfig?: PublicKey;
  programId?: PublicKey;
  ray?: RaydiumCpmmAddresses;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const base = args.ray ?? raydiumCpmmAddresses(args.cluster);
  const ray = args.ammConfig ? { ...base, ammConfig: args.ammConfig } : base;
  const curve = curvePda(args.mint, programId);
  const migration = migrationAuthorityPda(args.mint, programId);
  const p = cpmmPoolAccounts(args.mint, ray, programId);
  return new TransactionInstruction({
    programId,
    data: ixDiscriminator("migrate"),
    keys: [
      AM(args.payer, true, true),
      AM(configPda(programId), false, false),
      AM(args.mint, false, false),
      AM(curve, false, true),
      AM(getAssociatedTokenAddressSync(args.mint, curve, true), false, true),
      AM(solVaultPda(args.mint, programId), false, true),
      AM(protocolVaultPda(args.mint, programId), false, true),
      AM(migration, false, true),
      AM(getAssociatedTokenAddressSync(NATIVE_MINT, migration, true), false, true),
      AM(getAssociatedTokenAddressSync(args.mint, migration, true), false, true),
      AM(p.migrationLp, false, true),
      AM(NATIVE_MINT, false, false),
      AM(args.feeRecipient, false, true),
      AM(ray.program, false, false),
      AM(ray.authority, false, false),
      AM(ray.ammConfig, false, false),
      AM(ray.createPoolFeeReceiver, false, true),
      AM(p.poolState, false, true),
      AM(p.lpMint, false, true),
      AM(p.vault0, false, true),
      AM(p.vault1, false, true),
      AM(p.observation, false, true),
      AM(TOKEN_PROGRAM_ID, false, false),
      AM(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      AM(SystemProgram.programId, false, false),
      AM(SYSVAR_RENT_PUBKEY, false, false),
      ...eventCpiKeys(programId),
    ],
  });
}

/**
 * Sweeps a coin's accrued protocol fees to the configured fee recipient.
 * Permissionless to call — the destination is fixed on chain. Before the
 * curve has migrated the program keeps the graduation overhead back, so a
 * pre-graduation sweep never pushes that cost onto the raise.
 */
/**
 * Hands a graduated coin's LP to Raydium's locker (mainnet only — the
 * locker is not deployed on devnet). Permissionless: every destination is
 * derived on chain, and the coin's own protocol vault pays the rent, so the
 * caller spends nothing but a signature.
 */
export function buildLockGraduatedLiquidityIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  poolState: PublicKey;
  lockProgram: PublicKey;
  ray: RaydiumCpmmAddresses;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const p = cpmmPoolAccounts(args.mint, args.ray, programId);
  const feeAuthority = feeAuthorityPda(args.mint, programId);
  const feeNftMint = feeNftMintPda(args.mint, programId);
  const lockAuthority = lockCpAuthorityPda(args.lockProgram);
  const migration = migrationAuthorityPda(args.mint, programId);
  return new TransactionInstruction({
    programId,
    data: ixDiscriminator("lock_graduated_liquidity"),
    keys: [
      AM(args.payer, true, true),
      AM(configPda(programId), false, false),
      AM(args.mint, false, false),
      AM(curvePda(args.mint, programId), false, false),
      AM(graduatedFeesPda(args.mint, programId), false, true),
      AM(protocolVaultPda(args.mint, programId), false, true),
      AM(migration, false, true),
      AM(feeAuthority, false, false),
      AM(feeNftMint, false, true),
      AM(getAssociatedTokenAddressSync(feeNftMint, feeAuthority, true), false, true),
      AM(p.migrationLp, false, true),
      AM(args.lockProgram, false, false),
      AM(lockAuthority, false, false),
      AM(lockedLiquidityPda(feeNftMint, args.lockProgram), false, true),
      AM(getAssociatedTokenAddressSync(p.lpMint, lockAuthority, true), false, true),
      AM(p.lpMint, false, true),
      AM(args.poolState, false, false),
      AM(p.vault0, false, true),
      AM(p.vault1, false, true),
      AM(metadataPda(feeNftMint, MPL_TOKEN_METADATA_PROGRAM_ID), false, true),
      AM(MPL_TOKEN_METADATA_PROGRAM_ID, false, false),
      AM(TOKEN_PROGRAM_ID, false, false),
      AM(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      AM(SystemProgram.programId, false, false),
      AM(SYSVAR_RENT_PUBKEY, false, false),
    ],
  });
}

/**
 * Collects a graduated pool's trading fees and splits them: the coin side
 * 100% to the creator, the SOL side repaying the graduation cost and then
 * splitting per `graduatedFeeProtocolBps`. Permissionless.
 *
 * The four token accounts must exist — prepend
 * `createAssociatedTokenAccountIdempotentInstruction` for each, or run the
 * keeper's crank which does it.
 */
export function buildCollectGraduatedFeesIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  feeRecipient: PublicKey;
  poolState: PublicKey;
  lockProgram: PublicKey;
  ray: RaydiumCpmmAddresses;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const p = cpmmPoolAccounts(args.mint, args.ray, programId);
  const feeAuthority = feeAuthorityPda(args.mint, programId);
  const feeNftMint = feeNftMintPda(args.mint, programId);
  const lockAuthority = lockCpAuthorityPda(args.lockProgram);
  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true);
  return new TransactionInstruction({
    programId,
    data: ixDiscriminator("collect_graduated_fees"),
    keys: [
      AM(args.payer, true, true),
      AM(configPda(programId), false, false),
      AM(args.mint, false, false),
      AM(curvePda(args.mint, programId), false, false),
      AM(graduatedFeesPda(args.mint, programId), false, true),
      AM(feeAuthority, false, false),
      AM(ata(feeNftMint, feeAuthority), false, false),
      AM(ata(NATIVE_MINT, feeAuthority), false, true),
      AM(ata(args.mint, args.creator), false, true),
      AM(ata(NATIVE_MINT, args.creator), false, true),
      AM(ata(NATIVE_MINT, args.feeRecipient), false, true),
      AM(args.creator, false, false),
      AM(args.feeRecipient, false, false),
      AM(NATIVE_MINT, false, false),
      AM(args.lockProgram, false, false),
      AM(lockAuthority, false, false),
      AM(lockedLiquidityPda(feeNftMint, args.lockProgram), false, true),
      AM(args.ray.program, false, false),
      AM(args.ray.authority, false, false),
      AM(args.poolState, false, true),
      AM(p.lpMint, false, true),
      AM(p.vault0, false, true),
      AM(p.vault1, false, true),
      AM(ata(p.lpMint, lockAuthority), false, true),
      AM(TOKEN_PROGRAM_ID, false, false),
      AM(TOKEN_2022_PROGRAM_ID, false, false),
      AM(MEMO_PROGRAM_ID, false, false),
    ],
  });
}

export function buildCollectProtocolFeeIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
  ammConfig: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: ixDiscriminator("collect_protocol_fee"),
    keys: [
      AM(args.payer, true, true),
      AM(configPda(programId), false, false),
      AM(args.feeRecipient, false, true),
      AM(curvePda(args.mint, programId), false, false),
      AM(protocolVaultPda(args.mint, programId), false, true),
      AM(args.ammConfig, false, false),
      AM(SystemProgram.programId, false, false),
    ],
  });
}

export function buildCollectCreatorFeeIx(args: {
  payer: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    data: ixDiscriminator("collect_creator_fee"),
    keys: [
      AM(args.payer, true, true),
      AM(args.creator, false, true),
      AM(curvePda(args.mint, programId), false, false),
      AM(creatorVaultPda(args.creator, programId), false, true),
      AM(SystemProgram.programId, false, false),
    ],
  });
}

/** Convenience: the mint keypair a create_coin needs as a co-signer. */
export type MintKeypair = Keypair;
