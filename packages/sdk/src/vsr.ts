/**
 * Voter Stake Registry instruction builders.
 *
 * The deployed VSR (vsr2nf...) publishes no on-chain IDL and its client IDL
 * is legacy-anchor format (incompatible with @coral-xyz/anchor 0.30 Program),
 * so the two instructions we need are built manually against the vendored
 * IDL (src/idl/vsr.json, from @blockworks-foundation/voter-stake-registry-
 * client@0.2.3). See DECISIONS.md D-010.
 */
import { createHash } from "node:crypto";
import {
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
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
    [Buffer.from("registrar"), args.realm.toBuffer(), args.communityMint.toBuffer()],
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
