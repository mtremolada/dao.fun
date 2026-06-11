/**
 * Spec 6.8 `distribute` — merkle tree + distributor instruction builders.
 * The hashing here must match the IMMUTABLE deployed program (D-024); the
 * TS fold in verifyClaimProof mirrors the on-chain verifier, and the
 * bankrun integration suite proves compatibility against the real binary.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { MERKLE_DISTRIBUTOR_PROGRAM_ID } from "../src/constants";
import {
  buildClaimTree,
  buildClawbackIx,
  buildNewClaimIx,
  buildNewDistributorIx,
  deriveClaimStatus,
  deriveDistributor,
  verifyClaimProof,
  type ClaimShare,
} from "../src/merkle-distributor";

function makeShares(n: number): ClaimShare[] {
  return Array.from({ length: n }, (_, i) => ({
    claimant: Keypair.generate().publicKey,
    lamports: BigInt(1_000_000 * (i + 1)),
  }));
}

describe("buildClaimTree (jito-compatible hashing)", () => {
  it("every claimant's proof verifies under the on-chain fold; wrong amounts fail", () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const shares = makeShares(n);
      const tree = buildClaimTree(shares);
      for (const s of shares) {
        const proof = tree.proofFor(s.claimant);
        expect(verifyClaimProof(tree.root, s.claimant, s.lamports, proof)).toBe(
          true,
        );
        expect(
          verifyClaimProof(tree.root, s.claimant, s.lamports + 1n, proof),
        ).toBe(false);
      }
    }
  });

  it("the root is canonical: input order does not matter", () => {
    const shares = makeShares(7);
    const tree1 = buildClaimTree(shares);
    const tree2 = buildClaimTree([...shares].reverse());
    expect(tree1.root.equals(tree2.root)).toBe(true);
  });

  it("a single claimant: root == leaf, empty proof verifies", () => {
    const [share] = makeShares(1);
    const tree = buildClaimTree([share!]);
    expect(tree.proofFor(share!.claimant)).toHaveLength(0);
    expect(verifyClaimProof(tree.root, share!.claimant, share!.lamports, [])).toBe(
      true,
    );
  });

  it("totals and node count; unknown claimant throws", () => {
    const shares = makeShares(3);
    const tree = buildClaimTree(shares);
    expect(tree.totalLamports).toBe(6_000_000n);
    expect(tree.maxNumNodes).toBe(3n);
    expect(() => tree.proofFor(Keypair.generate().publicKey)).toThrow(
      /not in the tree/,
    );
  });

  it("rejects empty, non-positive, and duplicate shares", () => {
    expect(() => buildClaimTree([])).toThrow(/non-empty/);
    const claimant = Keypair.generate().publicKey;
    expect(() => buildClaimTree([{ claimant, lamports: 0n }])).toThrow(
      /positive/,
    );
    expect(() =>
      buildClaimTree([
        { claimant, lamports: 1n },
        { claimant, lamports: 2n },
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("distributor instruction builders (vendored IDL, D-024)", () => {
  const admin = Keypair.generate().publicKey;
  const version = 7n;
  const distributor = deriveDistributor(version);
  const tokenVault = getAssociatedTokenAddressSync(NATIVE_MINT, distributor, true);
  const clawbackReceiver = getAssociatedTokenAddressSync(NATIVE_MINT, admin, true);

  it("newDistributor: admin is the only signer; data is 88 bytes; vault ATA derived", () => {
    const built = buildNewDistributorIx({
      version,
      root: Buffer.alloc(32, 7),
      maxTotalClaim: 1_000n,
      maxNumNodes: 2n,
      startVestingTs: 100n,
      endVestingTs: 200n,
      clawbackStartTs: 200n + 86_400n,
      admin,
      clawbackReceiver,
    });
    expect(built.ix.programId.equals(MERKLE_DISTRIBUTOR_PROGRAM_ID)).toBe(true);
    expect(built.ix.data).toHaveLength(8 + 8 + 32 + 8 + 8 + 8 + 8 + 8);
    expect(built.distributor.equals(distributor)).toBe(true);
    expect(built.tokenVault.equals(tokenVault)).toBe(true);
    const signers = built.ix.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.pubkey.equals(admin)).toBe(true);
  });

  it("newClaim: claimant is the only signer; double-claim guard PDA in the keys", () => {
    const claimant = Keypair.generate().publicKey;
    const built = buildNewClaimIx({
      distributor,
      claimant,
      amountUnlocked: 500n,
      proof: [Buffer.alloc(32, 1), Buffer.alloc(32, 2)],
    });
    const signers = built.ix.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.pubkey.equals(claimant)).toBe(true);
    expect(built.claimStatus.equals(deriveClaimStatus(claimant, distributor))).toBe(
      true,
    );
    expect(
      built.ix.keys.some((k) => k.pubkey.equals(built.claimStatus) && k.isWritable),
    ).toBe(true);
    // data: disc + unlocked + locked + vec<[u8;32]> of 2
    expect(built.ix.data).toHaveLength(8 + 8 + 8 + 4 + 64);
  });

  it("clawback: permissionless (any payer signs), routes vault -> receiver", () => {
    const payer = Keypair.generate().publicKey;
    const ix = buildClawbackIx({ distributor, clawbackReceiver, payer });
    const signers = ix.keys.filter((k) => k.isSigner);
    expect(signers).toHaveLength(1);
    expect(signers[0]!.pubkey.equals(payer)).toBe(true);
    expect(
      ix.keys.some((k) => k.pubkey.equals(tokenVault) && k.isWritable),
    ).toBe(true);
    expect(
      ix.keys.some((k) => k.pubkey.equals(clawbackReceiver) && k.isWritable),
    ).toBe(true);
  });

  it("PDA derivations live under the verified program id", () => {
    expect(
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("MerkleDistributor"),
          NATIVE_MINT.toBuffer(),
          Buffer.from([7, 0, 0, 0, 0, 0, 0, 0]),
        ],
        MERKLE_DISTRIBUTOR_PROGRAM_ID,
      )[0].equals(distributor),
    ).toBe(true);
  });
});
