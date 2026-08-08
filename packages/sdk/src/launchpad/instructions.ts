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
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  LAUNCHPAD_PROGRAM_ID,
  MPL_TOKEN_METADATA_PROGRAM_ID,
  ixDiscriminator,
  type Cluster,
  type RaydiumCpmmAddresses,
} from "./constants";
import { raydiumCpmmAddresses } from "./constants";
import {
  configPda,
  cpmmPoolAccounts,
  creatorVaultPda,
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
  feeRecipient: PublicKey;
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
    AM(args.feeRecipient, false, true),
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
  feeRecipient: PublicKey;
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
  feeRecipient: PublicKey;
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
  programId?: PublicKey;
  ray?: RaydiumCpmmAddresses;
}): TransactionInstruction {
  const programId = args.programId ?? LAUNCHPAD_PROGRAM_ID;
  const ray = args.ray ?? raydiumCpmmAddresses(args.cluster);
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
