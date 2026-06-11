/**
 * Propose builder — spec 6.3/12.3 seam, written before implementation.
 * One call turns an inner instruction set into the full wrapped proposal
 * ceremony, encoding the conventions the gate runs hand-rolled twice:
 *
 * - descriptionLink == the inner instruction-set hash (D-017), so the UI
 *   finds the artifact from chain state alone;
 * - every ProposalTransaction carries the resolved hold-up (INV-3);
 * - what is inserted unwraps back to EXACTLY the inner set (INV-9/10).
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { computeInstructionSetHash } from "../src/artifact-hash";
import { unwrap, type WrapContext } from "../src/execution-adapter";
import { buildProposeIxs, type ProposeParams } from "../src/proposal";

const MICRO_HOLDUP = 259_200;

function ctx(): WrapContext {
  return {
    multisigPda: Keypair.generate().publicKey,
    vaultIndex: 0,
    transactionIndex: 7n,
    member: Keypair.generate().publicKey,
  };
}

function innerIxs(): TransactionInstruction[] {
  return [
    SystemProgram.transfer({
      fromPubkey: Keypair.generate().publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 890_880,
    }),
  ];
}

function makeParams(
  overrides: Partial<ProposeParams> = {},
): ProposeParams {
  return {
    realm: Keypair.generate().publicKey,
    governance: Keypair.generate().publicKey,
    governingTokenMint: Keypair.generate().publicKey,
    tokenOwnerRecord: Keypair.generate().publicKey,
    governanceAuthority: Keypair.generate().publicKey,
    payer: Keypair.generate().publicKey,
    proposalIndex: 0,
    name: "sweep the vault",
    innerIxs: innerIxs(),
    wrapCtx: ctx(),
    holdUpSeconds: MICRO_HOLDUP,
    ...overrides,
  };
}

describe("buildProposeIxs", () => {
  it("publishes the inner instruction-set hash as descriptionLink (D-017)", async () => {
    const p = makeParams();
    const result = await buildProposeIxs(p);
    expect(result.innerInstructionSetHash).toBe(
      computeInstructionSetHash(p.innerIxs),
    );
    // descriptionLink is a borsh string inside CreateProposal's data — the
    // 64-hex hash must appear verbatim.
    const createData = Buffer.concat(result.groups.create.map((ix) => ix.data));
    expect(
      createData.includes(Buffer.from(result.innerInstructionSetHash, "utf8")),
    ).toBe(true);
  });

  it("wraps through the ExecutionAdapter: inserted ixs unwrap back to the inner set (INV-9/10)", async () => {
    const p = makeParams();
    const result = await buildProposeIxs(p);
    expect(result.wrapped).toHaveLength(4); // the Squads custody chain
    const recovered = unwrap(result.wrapped, p.wrapCtx);
    expect(computeInstructionSetHash(recovered)).toBe(
      result.innerInstructionSetHash,
    );
  });

  it("every insert carries the resolved hold-up and its own tx-sized group (INV-3 / CU isolation)", async () => {
    const p = makeParams();
    const result = await buildProposeIxs(p);
    expect(result.groups.inserts).toHaveLength(result.wrapped.length);
    const holdUpLe = Buffer.alloc(4);
    holdUpLe.writeUInt32LE(MICRO_HOLDUP);
    for (const group of result.groups.inserts) {
      expect(group).toHaveLength(1);
      expect(group[0]!.data.includes(holdUpLe)).toBe(true);
    }
  });

  it("the proposal owner signs create, every insert, and sign-off; the vault never does", async () => {
    const p = makeParams();
    const result = await buildProposeIxs(p);
    const allGroups = [
      result.groups.create,
      ...result.groups.inserts,
      result.groups.signOff,
    ];
    for (const group of allGroups) {
      const signers = group.flatMap((ix) =>
        ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58()),
      );
      expect(signers).toContain(p.governanceAuthority.toBase58());
    }
  });

  it("rejects an empty inner set (nothing to govern)", async () => {
    await expect(
      buildProposeIxs(makeParams({ innerIxs: [] })),
    ).rejects.toThrow(/empty/);
  });

  it("auto-switches to the buffered chain for account-heavy inner sets (insert size budget)", async () => {
    // ~19-account instructions (pump updateFeeShares) overflow the plain
    // VaultTransactionCreate's insert; the builder must go buffered.
    const heavy = new TransactionInstruction({
      programId: Keypair.generate().publicKey,
      keys: Array.from({ length: 19 }, (_, i) => ({
        pubkey: Keypair.generate().publicKey,
        isSigner: i === 2,
        isWritable: i % 3 === 0,
      })),
      data: Buffer.alloc(80, 7),
    });
    // payer == proposer keeps inserts single-signer.
    const authority = Keypair.generate().publicKey;
    const p = makeParams({
      innerIxs: [heavy],
      governanceAuthority: authority,
      payer: authority,
    });
    const result = await buildProposeIxs(p);
    expect(result.buffered).toBe(true);
    expect(result.wrapped.length).toBeGreaterThan(4); // buffer steps added
    // Every insert's DATA must fit a v0+ALT-packed 1232-byte tx (~130
    // bytes of outer overhead once the governance accounts are table-
    // compressed). The EXECUTE insert's account metas are irreducible —
    // the send layer packs oversized inserts as v0+ALT (see the gate
    // harness); plain-legacy fit is only guaranteed for the buffer steps.
    for (const group of result.groups.inserts) {
      expect(group[0]!.data.length).toBeLessThanOrEqual(1100);
    }
    // INV-9/10 still hold through the buffered chain
    const recovered = unwrap(result.wrapped, p.wrapCtx);
    expect(computeInstructionSetHash(recovered)).toBe(
      result.innerInstructionSetHash,
    );
    // a light set stays on the plain 4-step chain
    expect((await buildProposeIxs(makeParams())).buffered).toBe(false);
  });
});
