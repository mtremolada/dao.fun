/**
 * AUDIT — INV-9 chain-side recompute, SAFE verdict backed by regression.
 *
 * The production chain reader recomputes a proposal's instruction-set hash
 * from the re-read ProposalTransactions via `hashWrappedInstructionSet`
 * (chain-reader.ts), and the UI badge compares it to the published artifact
 * hash (descriptionLink). The publish-side hash is built by `buildProposeIxs`
 * from `unwrap(chain) ++ directIxs`. For the badge to be trustworthy the two
 * must be EQUAL for every wrapped shape the launchpad creates.
 *
 * The integration suite only exercises the chain-side recompute (`chainHashOf`)
 * for plain Squads-wrapped VAULT proposals (gate1-matrix). The other three
 * load-bearing shapes — buffered chains (distribute / account-heavy),
 * direct-leg-only proposals (setParam: exercises the `catch` raw-hash
 * fallback), and vault+direct proposals (staged AMM) — were unverified on the
 * recompute side. This pins all four: publish hash == chain recompute over the
 * exact instruction list stored on chain (`made.wrapped`).
 */
import { describe, expect, it } from "vitest";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { buildProposeIxs, type WrapContext } from "@daofun/sdk";
import { hashWrappedInstructionSet } from "../src/chain-reader";

const realm = PublicKey.unique();
const governance = PublicKey.unique();
const mint = PublicKey.unique();
const tor = PublicKey.unique();
const authority = PublicKey.unique();
const multisigPda = PublicKey.unique();
const nativeTreasury = PublicKey.unique();
const vault = PublicKey.unique();
const recipient = PublicKey.unique();

const wrapCtx: WrapContext = {
  multisigPda,
  vaultIndex: 0,
  transactionIndex: 1n,
  member: nativeTreasury,
};

async function propose(
  innerIxs: TransactionInstruction[],
  directIxs: TransactionInstruction[],
) {
  return buildProposeIxs({
    realm,
    governance,
    governingTokenMint: mint,
    tokenOwnerRecord: tor,
    governanceAuthority: authority,
    payer: authority,
    proposalIndex: 0,
    name: "audit inv-9",
    innerIxs,
    ...(directIxs.length > 0 ? { directIxs } : {}),
    wrapCtx,
    holdUpSeconds: 72 * 3600,
  });
}

const vaultTransfer = SystemProgram.transfer({
  fromPubkey: vault,
  toPubkey: recipient,
  lamports: 890_880,
});

// A single large-data instruction blows the vault message past the plain
// create-data budget, forcing buildProposeIxs onto the buffered Squads chain.
const bigInner = new TransactionInstruction({
  programId: PublicKey.unique(),
  keys: [{ pubkey: vault, isSigner: true, isWritable: true }],
  data: Buffer.alloc(800, 7),
});

// A direct (treasury-signed) leg, e.g. the setGovernanceConfig in setParam or
// the AMM return transfer in a staged buyback.
const directLeg = new TransactionInstruction({
  programId: PublicKey.unique(),
  keys: [
    { pubkey: governance, isSigner: true, isWritable: true },
    { pubkey: nativeTreasury, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([1, 2, 3, 4]),
});

describe("AUDIT INV-9: chain recompute == published hash for every wrapped shape", () => {
  it("plain vault chain", async () => {
    const made = await propose([vaultTransfer], []);
    expect(made.buffered).toBe(false);
    expect(hashWrappedInstructionSet(made.wrapped)).toBe(
      made.innerInstructionSetHash,
    );
  });

  it("buffered vault chain (account-heavy / distribute)", async () => {
    const made = await propose([bigInner], []);
    expect(made.buffered).toBe(true);
    expect(hashWrappedInstructionSet(made.wrapped)).toBe(
      made.innerInstructionSetHash,
    );
  });

  it("direct-leg-only (setParam — exercises the raw-hash catch fallback)", async () => {
    const made = await propose([], [directLeg]);
    // No Squads wrapping at all; unwrap throws and the recompute hashes raw.
    expect(hashWrappedInstructionSet(made.wrapped)).toBe(
      made.innerInstructionSetHash,
    );
  });

  it("vault chain + direct legs (staged AMM)", async () => {
    const made = await propose([vaultTransfer], [directLeg]);
    expect(hashWrappedInstructionSet(made.wrapped)).toBe(
      made.innerInstructionSetHash,
    );
  });
});
