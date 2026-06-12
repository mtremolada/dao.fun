/**
 * Stage 2 fuzz suite (spec Section 8): keeper/split arithmetic at u64
 * bounds (INV-6), merkle tree proofs under random share sets, and the
 * wrap/unwrap roundtrip under random instruction shapes. Randomized
 * inputs, exact assertions — no tolerance windows on money math.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { proRataShares, type HolderBalance } from "../src/snapshot";
import { buildClaimTree, verifyClaimProof } from "../src/merkle-distributor";
import { buildGrantIxs } from "../src/actions";
import { unwrap, wrap, type WrapContext } from "../src/execution-adapter";
import { buildProposeIxs } from "../src/proposal";
import { computeInstructionSetHash } from "../src/artifact-hash";

const U64_MAX = 2n ** 64n - 1n;

// pre-generate keypairs: Keypair.generate() inside fc loops is slow
const POOL = Array.from({ length: 64 }, () => Keypair.generate().publicKey);
const arbOwner = fc.nat({ max: POOL.length - 1 }).map((i) => POOL[i]!);

describe("proRataShares at u64 bounds (INV-6)", () => {
  const arbHolders = fc
    .array(
      fc.record({
        owner: arbOwner,
        amount: fc.bigInt({ min: 0n, max: U64_MAX }),
      }),
      { minLength: 1, maxLength: 24 },
    )
    .filter((hs) => hs.some((h) => h.amount > 0n));

  it("never over-allocates, books always close, every share fits u64", () => {
    fc.assert(
      fc.property(
        arbHolders,
        fc.bigInt({ min: 1n, max: U64_MAX }),
        (holders: HolderBalance[], totalLamports) => {
          const r = proRataShares({ holders, totalLamports });
          let sum = 0n;
          for (const s of r.shares) {
            expect(s.lamports > 0n).toBe(true);
            expect(s.lamports <= U64_MAX).toBe(true);
            sum += s.lamports;
          }
          expect(sum).toBe(r.allocatedLamports);
          expect(r.allocatedLamports + r.dustLamports).toBe(totalLamports);
          expect(r.allocatedLamports <= totalLamports).toBe(true);
          // pro-rata exactness: each owner's share == floor(total*held/supply)
          const byOwner = new Map<string, bigint>();
          for (const h of holders) {
            byOwner.set(
              h.owner.toBase58(),
              (byOwner.get(h.owner.toBase58()) ?? 0n) + h.amount,
            );
          }
          for (const s of r.shares) {
            const held = byOwner.get(s.claimant.toBase58())!;
            expect(s.lamports).toBe((totalLamports * held) / r.heldSupply);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("merkle claim tree under random share sets", () => {
  it("every proof verifies; any tampered amount fails", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: POOL.length - 1 }), {
          minLength: 1,
          maxLength: 16,
        }),
        fc.bigInt({ min: 1n, max: U64_MAX / 32n }),
        fc.nat({ max: 15 }),
        (ownerIdx, base, tamperPick) => {
          const shares = ownerIdx.map((i, k) => ({
            claimant: POOL[i]!,
            lamports: base + BigInt(k),
          }));
          const tree = buildClaimTree(shares);
          for (const s of shares) {
            expect(
              verifyClaimProof(
                tree.root,
                s.claimant,
                s.lamports,
                tree.proofFor(s.claimant),
              ),
            ).toBe(true);
          }
          const victim = shares[tamperPick % shares.length]!;
          expect(
            verifyClaimProof(
              tree.root,
              victim.claimant,
              victim.lamports + 1n,
              tree.proofFor(victim.claimant),
            ),
          ).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("the root is canonical: input order never changes it", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.nat({ max: POOL.length - 1 }), {
          minLength: 2,
          maxLength: 12,
        }),
        (ownerIdx) => {
          const shares = ownerIdx.map((i, k) => ({
            claimant: POOL[i]!,
            lamports: BigInt(k + 1) * 1_000n,
          }));
          const root = buildClaimTree(shares).root;
          const reversed = buildClaimTree([...shares].reverse()).root;
          expect(root.equals(reversed)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("grant bounds under fuzz (the simplest fund path stays exact)", () => {
  const vault = POOL[0]!;
  const recipient = POOL[1]!;

  it("builds iff 0 < lamports <= balance - floor; never silently clamps", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -10n, max: U64_MAX }),
        fc.bigInt({ min: 0n, max: U64_MAX }),
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        (lamports, balance, floor) => {
          const build = () =>
            buildGrantIxs({
              vault,
              recipient,
              lamports,
              vaultBalanceLamports: balance,
              rentFloorLamports: floor,
            });
          const legal =
            lamports > 0n && lamports <= balance && balance - lamports >= floor;
          if (legal) {
            const ix = build()[0]!;
            // exact amount, little-endian u64 at offset 4 of the transfer data
            expect(ix.data.readBigUInt64LE(4)).toBe(lamports);
          } else {
            expect(build).toThrow();
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("wrap/unwrap roundtrip under random instruction shapes (INV-9 decoder seam)", () => {
  const ctx: WrapContext = {
    multisigPda: POOL[2]!,
    vaultIndex: 0,
    transactionIndex: 7n,
    member: POOL[3]!,
  };

  const arbIx = fc
    .record({
      programIdx: fc.nat({ max: POOL.length - 1 }),
      keys: fc.array(
        fc.record({
          idx: fc.nat({ max: POOL.length - 1 }),
          isSigner: fc.boolean(),
          isWritable: fc.boolean(),
        }),
        { maxLength: 6 },
      ),
      data: fc.uint8Array({ maxLength: 48 }),
    })
    .map(
      ({ programIdx, keys, data }) =>
        new TransactionInstruction({
          programId: POOL[programIdx]!,
          keys: keys.map((k) => ({
            pubkey: POOL[k.idx]!,
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Buffer.from(data),
        }),
    );

  /**
   * Message-wide privilege normalization (found BY this suite, D-027):
   * the Squads transaction message stores ONE privilege level per account
   * — signer/writable = the max across the whole inner set, exactly the
   * Solana runtime's own semantics. unwrap() therefore recovers the
   * NORMALIZED flags, not the per-ix originals.
   */
  function normalizedFlags(inner: TransactionInstruction[]) {
    const flags = new Map<string, { isSigner: boolean; isWritable: boolean }>();
    for (const ix of inner) {
      for (const k of ix.keys) {
        const cur = flags.get(k.pubkey.toBase58()) ?? {
          isSigner: false,
          isWritable: false,
        };
        flags.set(k.pubkey.toBase58(), {
          isSigner: cur.isSigner || k.isSigner,
          isWritable: cur.isWritable || k.isWritable,
        });
      }
    }
    return flags;
  }

  it("unwrap(wrap(x)) == x up to message-wide privilege normalization", () => {
    fc.assert(
      fc.property(
        fc.array(arbIx, { minLength: 1, maxLength: 4 }),
        (inner: TransactionInstruction[]) => {
          const flags = normalizedFlags(inner);
          const recovered = unwrap(wrap(inner, ctx), ctx);
          expect(recovered.length).toBe(inner.length);
          for (let i = 0; i < inner.length; i++) {
            const a = recovered[i]!;
            const b = inner[i]!;
            expect(a.programId.equals(b.programId)).toBe(true);
            expect(a.data.equals(b.data)).toBe(true);
            expect(a.keys.length).toBe(b.keys.length);
            for (let j = 0; j < a.keys.length; j++) {
              expect(a.keys[j]!.pubkey.equals(b.keys[j]!.pubkey)).toBe(true);
              const f = flags.get(b.keys[j]!.pubkey.toBase58())!;
              expect(a.keys[j]!.isSigner).toBe(f.isSigner);
              expect(a.keys[j]!.isWritable).toBe(f.isWritable);
            }
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it("INV-9 by construction: the published hash equals the chain-recovered hash even for conflicting-flag inner sets (regression, D-027)", async () => {
    // the same account read-only in one ix and signer-writable in the next
    const shared = POOL[4]!;
    const inner = [
      new TransactionInstruction({
        programId: POOL[5]!,
        keys: [{ pubkey: shared, isSigner: false, isWritable: false }],
        data: Buffer.from([1]),
      }),
      new TransactionInstruction({
        programId: POOL[5]!,
        keys: [{ pubkey: shared, isSigner: true, isWritable: true }],
        data: Buffer.from([2]),
      }),
    ];
    const made = await buildProposeIxs({
      realm: POOL[6]!,
      governance: POOL[7]!,
      governingTokenMint: POOL[8]!,
      tokenOwnerRecord: POOL[9]!,
      governanceAuthority: POOL[10]!,
      payer: POOL[10]!,
      proposalIndex: 0,
      name: "conflicting flags",
      innerIxs: inner,
      wrapCtx: ctx,
      holdUpSeconds: 0,
    });
    // what the backend chain reader recomputes from the on-chain set:
    const recovered = unwrap(made.wrapped, ctx);
    expect(computeInstructionSetHash(recovered)).toBe(
      made.innerInstructionSetHash,
    );
    // and it differs from the naive raw-inner hash — the latent red badge
    // the fuzz suite caught:
    expect(computeInstructionSetHash(inner)).not.toBe(
      made.innerInstructionSetHash,
    );
  });
});

// keep linters honest about unused type-only imports in some TS configs
void (0 as unknown as PublicKey);
