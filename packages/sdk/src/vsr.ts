/**
 * Voter Stake Registry instruction builders.
 *
 * The deployed VSR (vsr2nf...) publishes no on-chain IDL and its client IDL
 * is legacy-anchor format (incompatible with @coral-xyz/anchor 0.30 Program),
 * so the two instructions we need are built manually against the vendored
 * IDL (src/idl/vsr.json, from @blockworks-foundation/voter-stake-registry-
 * client@0.2.3). See DECISIONS.md D-010.
 */
import { createHash } from "./sha256";
import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SPL_GOVERNANCE_PROGRAM_ID, VSR_PROGRAM_ID } from "./constants";
import { deriveVsrRegistrar } from "./pda";

function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

/** VSR scaled factors use 1e9 as 1.0 (per VSR source). */
export const VSR_SCALED_FACTOR_BASE = 1_000_000_000n;

export function buildCreateRegistrarIx(args: {
  realm: PublicKey;
  communityMint: PublicKey;
  realmAuthority: PublicKey;
  payer: PublicKey;
}): { ix: TransactionInstruction; registrar: PublicKey } {
  const [registrar, registrarBump] = PublicKey.findProgramAddressSync(
    // Object-first seed order, like the voter PDA (verified on the real
    // binary by the GATE 1 bankrun VSR leg — see deriveVsrRegistrar).
    [args.realm.toBuffer(), Buffer.from("registrar"), args.communityMint.toBuffer()],
    VSR_PROGRAM_ID,
  );
  const data = Buffer.concat([
    anchorDiscriminator("create_registrar"),
    Buffer.from([registrarBump]),
  ]);
  const ix = new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: registrar, isSigner: false, isWritable: true },
      { pubkey: args.realm, isSigner: false, isWritable: false },
      { pubkey: SPL_GOVERNANCE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: args.communityMint, isSigner: false, isWritable: false },
      { pubkey: args.realmAuthority, isSigner: true, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
  if (!registrar.equals(deriveVsrRegistrar(args.realm, args.communityMint))) {
    throw new Error("registrar derivation drift"); // pinned by pda tests
  }
  return { ix, registrar };
}

export function buildConfigureVotingMintIx(args: {
  registrar: PublicKey;
  realmAuthority: PublicKey;
  mint: PublicKey;
  idx: number;
  digitShift: number;
  /** 0 == unlocked deposits carry zero weight (spec 6.3 approximation). */
  baselineVoteWeightScaledFactor: bigint;
  maxExtraLockupVoteWeightScaledFactor: bigint;
  lockupSaturationSecs: bigint;
  grantAuthority?: PublicKey;
}): TransactionInstruction {
  const head = Buffer.alloc(8 + 2 + 1 + 8 + 8 + 8);
  anchorDiscriminator("configure_voting_mint").copy(head, 0);
  head.writeUInt16LE(args.idx, 8);
  head.writeInt8(args.digitShift, 10);
  head.writeBigUInt64LE(args.baselineVoteWeightScaledFactor, 11);
  head.writeBigUInt64LE(args.maxExtraLockupVoteWeightScaledFactor, 19);
  head.writeBigUInt64LE(args.lockupSaturationSecs, 27);
  const option = args.grantAuthority
    ? Buffer.concat([Buffer.from([1]), args.grantAuthority.toBuffer()])
    : Buffer.from([0]);
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: true },
      { pubkey: args.realmAuthority, isSigner: true, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      // remaining accounts: every configured voting mint (just ours at idx 0)
      { pubkey: args.mint, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([head, option]),
  });
}

// ---------------------------------------------------------------------------
// Voter-side instructions (createVoter / deposit / weight / withdraw / close).
// Seeds verified against program source 2026-06-11 (see vsr-voter tests).
// NOTE: the deployed VSR uses anchor_spl::token (classic SPL Token only) for
// its deposit vault; Token-2022 community mints are expected to be rejected
// on-chain. The builders still take a tokenProgram so the incompatibility can
// be demonstrated (and revisited if the program is ever upgraded).
// ---------------------------------------------------------------------------

/** LockupKind in program declaration order. */
export enum LockupKind {
  None = 0,
  Daily = 1,
  Monthly = 2,
  Cliff = 3,
  Constant = 4,
}

export function deriveVsrVoter(
  registrar: PublicKey,
  voterAuthority: PublicKey,
): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [registrar.toBuffer(), Buffer.from("voter"), voterAuthority.toBuffer()],
    VSR_PROGRAM_ID,
  );
  return { address, bump };
}

export function deriveVsrVoterWeightRecord(
  registrar: PublicKey,
  voterAuthority: PublicKey,
): { address: PublicKey; bump: number } {
  const [address, bump] = PublicKey.findProgramAddressSync(
    [
      registrar.toBuffer(),
      Buffer.from("voter-weight-record"),
      voterAuthority.toBuffer(),
    ],
    VSR_PROGRAM_ID,
  );
  return { address, bump };
}

export function buildCreateVoterIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  payer: PublicKey;
}): { ix: TransactionInstruction; voter: PublicKey; voterWeightRecord: PublicKey } {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority);
  const vwr = deriveVsrVoterWeightRecord(args.registrar, args.voterAuthority);
  const data = Buffer.concat([
    anchorDiscriminator("create_voter"),
    Buffer.from([voter.bump, vwr.bump]),
  ]);
  const ix = new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter.address, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
      { pubkey: vwr.address, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, voter: voter.address, voterWeightRecord: vwr.address };
}

export function buildCreateDepositEntryIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  payer: PublicKey;
  depositMint: PublicKey;
  depositEntryIndex: number;
  kind: LockupKind;
  startTs?: bigint;
  periods: number;
  allowClawback: boolean;
  tokenProgram?: PublicKey;
}): { ix: TransactionInstruction; vault: PublicKey } {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ID;
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  const vault = getAssociatedTokenAddressSync(
    args.depositMint,
    voter,
    true,
    tokenProgram,
  );
  const startTs =
    args.startTs !== undefined
      ? Buffer.concat([Buffer.from([1]), u64le(args.startTs)])
      : Buffer.from([0]);
  const tail = Buffer.alloc(5);
  tail.writeUInt32LE(args.periods, 0);
  tail.writeUInt8(args.allowClawback ? 1 : 0, 4);
  const data = Buffer.concat([
    anchorDiscriminator("create_deposit_entry"),
    Buffer.from([args.depositEntryIndex, args.kind]),
    startTs,
    tail,
  ]);
  const ix = new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.depositMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, vault };
}

export function buildDepositIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  vault: PublicKey;
  depositToken: PublicKey;
  depositEntryIndex: number;
  amount: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.depositToken, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
      {
        pubkey: args.tokenProgram ?? TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([
      anchorDiscriminator("deposit"),
      Buffer.from([args.depositEntryIndex]),
      u64le(args.amount),
    ]),
  });
}

export function buildWithdrawIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  tokenOwnerRecord: PublicKey;
  vault: PublicKey;
  destination: PublicKey;
  depositEntryIndex: number;
  amount: bigint;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  const vwr = deriveVsrVoterWeightRecord(args.registrar, args.voterAuthority).address;
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
      { pubkey: args.tokenOwnerRecord, isSigner: false, isWritable: false },
      { pubkey: vwr, isSigner: false, isWritable: true },
      { pubkey: args.vault, isSigner: false, isWritable: true },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      {
        pubkey: args.tokenProgram ?? TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: Buffer.concat([
      anchorDiscriminator("withdraw"),
      Buffer.from([args.depositEntryIndex]),
      u64le(args.amount),
    ]),
  });
}

export function buildUpdateVoterWeightRecordIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
}): TransactionInstruction {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  const vwr = deriveVsrVoterWeightRecord(args.registrar, args.voterAuthority).address;
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: false },
      { pubkey: vwr, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("update_voter_weight_record"),
  });
}

export function buildCloseDepositEntryIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  depositEntryIndex: number;
}): TransactionInstruction {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: voter, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([
      anchorDiscriminator("close_deposit_entry"),
      Buffer.from([args.depositEntryIndex]),
    ]),
  });
}

export function buildCloseVoterIx(args: {
  registrar: PublicKey;
  voterAuthority: PublicKey;
  solDestination: PublicKey;
  tokenProgram?: PublicKey;
}): TransactionInstruction {
  const voter = deriveVsrVoter(args.registrar, args.voterAuthority).address;
  return new TransactionInstruction({
    programId: VSR_PROGRAM_ID,
    keys: [
      { pubkey: args.registrar, isSigner: false, isWritable: false },
      { pubkey: voter, isSigner: false, isWritable: true },
      { pubkey: args.voterAuthority, isSigner: true, isWritable: false },
      { pubkey: args.solDestination, isSigner: false, isWritable: true },
      {
        pubkey: args.tokenProgram ?? TOKEN_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: anchorDiscriminator("close_voter"),
  });
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
