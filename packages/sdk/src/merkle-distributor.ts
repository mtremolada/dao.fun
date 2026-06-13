/**
 * Jito merkle distributor (spec 6.8 `distribute`) — tree + instruction
 * builders against the IMMUTABLE mainnet deployment (D-024):
 * mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv, upgrade authority removed,
 * on-chain anchor IDL vendored at src/idl/merkle-distributor.json.
 *
 * Hashing mirrors the deployed program exactly (verified against its
 * source lineage and the real binary in bankrun):
 *   inner  = sha256(claimant || u64le(unlocked) || u64le(locked))
 *   leaf   = sha256([0] || inner)
 *   branch = sha256([1] || min(l,r) || max(l,r))   (OpenZeppelin-style
 *            commutative fold — the verifier sorts each pair by value)
 * An odd node is promoted to the next level unchanged; leaves are sorted
 * so a share SET has one canonical root regardless of input order.
 *
 * The distribution token is WSOL (spec: `totalLamports`): holders claim
 * SOL-equivalents; pump DAO tokens are Token-2022 which this program
 * predates, so the DAO's own token is NOT distributable here.
 */
import { createHash } from "./sha256";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from "./constants";

export interface ClaimShare {
  claimant: PublicKey;
  lamports: bigint;
}

export interface MerkleClaimTree {
  root: Buffer; // 32 bytes
  totalLamports: bigint;
  maxNumNodes: bigint;
  proofFor(claimant: PublicKey): Buffer[];
}

const LEAF_PREFIX = Buffer.from([0]);
const INTERMEDIATE_PREFIX = Buffer.from([1]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function u64le(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}

function anchorDiscriminator(ixName: string): Buffer {
  return createHash("sha256").update(`global:${ixName}`).digest().subarray(0, 8);
}

function leafHash(claimant: PublicKey, lamports: bigint): Buffer {
  // amountLocked is always 0: spec's distribute is an instant claim window,
  // not a vesting schedule.
  return sha256(LEAF_PREFIX, sha256(claimant.toBuffer(), u64le(lamports), u64le(0n)));
}

function pairHash(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0
    ? sha256(INTERMEDIATE_PREFIX, a, b)
    : sha256(INTERMEDIATE_PREFIX, b, a);
}

export function buildClaimTree(shares: ClaimShare[]): MerkleClaimTree {
  if (shares.length === 0) {
    throw new Error("distribute: shares must be non-empty");
  }
  const seen = new Set<string>();
  let total = 0n;
  for (const s of shares) {
    if (s.lamports <= 0n) {
      throw new Error(
        `distribute: share for ${s.claimant.toBase58()} must be positive`,
      );
    }
    const key = s.claimant.toBase58();
    if (seen.has(key)) {
      throw new Error(`distribute: duplicate claimant ${key}`);
    }
    seen.add(key);
    total += s.lamports;
  }

  const entries = shares.map((s) => ({
    key: s.claimant.toBase58(),
    leaf: leafHash(s.claimant, s.lamports),
  }));
  entries.sort((x, y) => Buffer.compare(x.leaf, y.leaf));

  const proofs = new Map<string, Buffer[]>(entries.map((e) => [e.key, []]));
  const positions = new Map<string, number>(entries.map((e, i) => [e.key, i]));
  let level = entries.map((e) => e.leaf);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(
        i + 1 < level.length ? pairHash(level[i]!, level[i + 1]!) : level[i]!,
      );
    }
    for (const [key, pos] of positions) {
      const sibling = pos ^ 1;
      if (sibling < level.length) proofs.get(key)!.push(level[sibling]!);
      positions.set(key, pos >> 1);
    }
    level = next;
  }

  return {
    root: level[0]!,
    totalLamports: total,
    maxNumNodes: BigInt(shares.length),
    proofFor(claimant: PublicKey): Buffer[] {
      const proof = proofs.get(claimant.toBase58());
      if (!proof) {
        throw new Error(`distribute: ${claimant.toBase58()} is not in the tree`);
      }
      return proof;
    },
  };
}

/** TS mirror of the on-chain proof fold (jito_merkle_verify). */
export function verifyClaimProof(
  root: Buffer,
  claimant: PublicKey,
  lamports: bigint,
  proof: Buffer[],
): boolean {
  let computed = leafHash(claimant, lamports);
  for (const el of proof) computed = pairHash(computed, el);
  return computed.equals(root);
}

/** ["MerkleDistributor", mint, u64le(version)] — global (mint, version) namespace. */
export function deriveDistributor(
  version: bigint,
  mint: PublicKey = NATIVE_MINT,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("MerkleDistributor"), mint.toBuffer(), u64le(version)],
    MERKLE_DISTRIBUTOR_PROGRAM_ID,
  )[0];
}

/** ["ClaimStatus", claimant, distributor] — the double-claim guard. */
export function deriveClaimStatus(
  claimant: PublicKey,
  distributor: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ClaimStatus"), claimant.toBuffer(), distributor.toBuffer()],
    MERKLE_DISTRIBUTOR_PROGRAM_ID,
  )[0];
}

export interface NewDistributorArgs {
  version: bigint;
  root: Buffer;
  maxTotalClaim: bigint;
  maxNumNodes: bigint;
  startVestingTs: bigint;
  endVestingTs: bigint;
  clawbackStartTs: bigint;
  /** Pays rent and becomes distributor admin — the DAO vault (inner signer). */
  admin: PublicKey;
  /** Token account unclaimed funds return to (must exist at execution). */
  clawbackReceiver: PublicKey;
  mint?: PublicKey;
}

export function buildNewDistributorIx(args: NewDistributorArgs): {
  ix: TransactionInstruction;
  distributor: PublicKey;
  tokenVault: PublicKey;
} {
  if (args.root.length !== 32) {
    throw new Error("distribute: root must be 32 bytes");
  }
  const mint = args.mint ?? NATIVE_MINT;
  const distributor = deriveDistributor(args.version, mint);
  const tokenVault = getAssociatedTokenAddressSync(mint, distributor, true);
  const data = Buffer.concat([
    anchorDiscriminator("new_distributor"),
    u64le(args.version),
    args.root,
    u64le(args.maxTotalClaim),
    u64le(args.maxNumNodes),
    u64le(BigInt.asUintN(64, args.startVestingTs)),
    u64le(BigInt.asUintN(64, args.endVestingTs)),
    u64le(BigInt.asUintN(64, args.clawbackStartTs)),
  ]);
  const ix = new TransactionInstruction({
    programId: MERKLE_DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: distributor, isSigner: false, isWritable: true },
      { pubkey: args.clawbackReceiver, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: args.admin, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, distributor, tokenVault };
}

export interface NewClaimArgs {
  distributor: PublicKey;
  claimant: PublicKey;
  amountUnlocked: bigint;
  proof: Buffer[];
  mint?: PublicKey;
}

/** Holder-side claim: the claimant is the only signer; pays ClaimStatus rent. */
export function buildNewClaimIx(args: NewClaimArgs): {
  ix: TransactionInstruction;
  claimStatus: PublicKey;
  to: PublicKey;
} {
  const mint = args.mint ?? NATIVE_MINT;
  const tokenVault = getAssociatedTokenAddressSync(mint, args.distributor, true);
  const to = getAssociatedTokenAddressSync(mint, args.claimant, false);
  const claimStatus = deriveClaimStatus(args.claimant, args.distributor);
  const data = Buffer.concat([
    anchorDiscriminator("new_claim"),
    u64le(args.amountUnlocked),
    u64le(0n), // amountLocked — always 0 (instant distribution)
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32LE(args.proof.length);
      return Buffer.concat([len, ...args.proof]);
    })(),
  ]);
  const ix = new TransactionInstruction({
    programId: MERKLE_DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: args.distributor, isSigner: false, isWritable: true },
      { pubkey: claimStatus, isSigner: false, isWritable: true },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: args.claimant, isSigner: true, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
  return { ix, claimStatus, to };
}

export interface ClawbackArgs {
  distributor: PublicKey;
  /** distributor.clawbackReceiver — the program enforces the match. */
  clawbackReceiver: PublicKey;
  /** Any signer: clawback is permissionless after clawbackStartTs. */
  payer: PublicKey;
  mint?: PublicKey;
}

export function buildClawbackIx(args: ClawbackArgs): TransactionInstruction {
  const mint = args.mint ?? NATIVE_MINT;
  const tokenVault = getAssociatedTokenAddressSync(mint, args.distributor, true);
  return new TransactionInstruction({
    programId: MERKLE_DISTRIBUTOR_PROGRAM_ID,
    keys: [
      { pubkey: args.distributor, isSigner: false, isWritable: true },
      { pubkey: tokenVault, isSigner: false, isWritable: true },
      { pubkey: args.clawbackReceiver, isSigner: false, isWritable: true },
      { pubkey: args.payer, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: anchorDiscriminator("clawback"),
  });
}
