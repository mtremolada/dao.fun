/**
 * Propose builder — the one call that turns an inner instruction set into
 * the full wrapped proposal ceremony (spec 6.3/12.3). Encodes the
 * conventions the mainnet gate runs hand-rolled:
 *
 * - the inner set is wrapped through the ExecutionAdapter (Squads custody
 *   chain), one ProposalTransaction per wrapped instruction (CU isolation);
 * - descriptionLink == the inner instruction-set hash (D-017): the UI can
 *   locate the artifact from chain state alone, and the badge verifies the
 *   re-read instructions against it (INV-9);
 * - every ProposalTransaction carries the resolved hold-up (INV-3).
 *
 * Callers send groups in order: create, each insert, signOff. Reminder
 * (D-016): the native treasury must hold execution rent headroom before
 * the proposal executes — the launch flow prefunds it.
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  VoteType,
  createInstructionData,
  withCreateProposal,
  withInsertTransaction,
  withSignOffProposal,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "./constants";
import { computeInstructionSetHash } from "./artifact-hash";
import { wrap, type WrapContext } from "./execution-adapter";

const PROGRAM_VERSION = 3;

export interface ProposeParams {
  realm: PublicKey;
  governance: PublicKey;
  governingTokenMint: PublicKey;
  /** The proposer's TokenOwnerRecord (community deposit / VSR-backed). */
  tokenOwnerRecord: PublicKey;
  /** The proposal owner; signs create, inserts, and sign-off. */
  governanceAuthority: PublicKey;
  payer: PublicKey;
  proposalIndex: number;
  name: string;
  innerIxs: TransactionInstruction[];
  wrapCtx: WrapContext;
  /** Resolved matrix hold-up (sovereign may be 0 by explicit choice). */
  holdUpSeconds: number;
  /** VSR voter-weight record; required for addin realms. */
  voterWeightRecord?: PublicKey;
}

export interface ProposeResult {
  proposal: PublicKey;
  /** Publish this with the artifact; it is also the descriptionLink. */
  innerInstructionSetHash: string;
  /** The ExecutionAdapter chain actually inserted on-chain. */
  wrapped: TransactionInstruction[];
  /** Send in order; each inner array is one transaction. */
  groups: {
    create: TransactionInstruction[];
    inserts: TransactionInstruction[][];
    signOff: TransactionInstruction[];
  };
}

export async function buildProposeIxs(
  p: ProposeParams,
): Promise<ProposeResult> {
  // wrap() rejects an empty inner set; hash it first for the same error
  // surface either way.
  if (p.innerIxs.length === 0) {
    throw new Error("buildProposeIxs: inner instruction set is empty");
  }
  const innerInstructionSetHash = computeInstructionSetHash(p.innerIxs);
  const wrapped = wrap(p.innerIxs, p.wrapCtx);

  const create: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    create,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    p.realm,
    p.governance,
    p.tokenOwnerRecord,
    p.name,
    innerInstructionSetHash, // D-017
    p.governingTokenMint,
    p.governanceAuthority,
    p.proposalIndex,
    VoteType.SINGLE_CHOICE,
    ["Approve"],
    true,
    p.payer,
    p.voterWeightRecord,
  );

  const inserts: TransactionInstruction[][] = [];
  for (const [i, ix] of wrapped.entries()) {
    const group: TransactionInstruction[] = [];
    await withInsertTransaction(
      group,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      p.governance,
      proposal,
      p.tokenOwnerRecord,
      p.governanceAuthority,
      i,
      0,
      p.holdUpSeconds,
      [createInstructionData(ix)],
      p.payer,
    );
    inserts.push(group);
  }

  const signOff: TransactionInstruction[] = [];
  withSignOffProposal(
    signOff,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    p.realm,
    p.governance,
    proposal,
    p.governanceAuthority,
    undefined,
    p.tokenOwnerRecord,
  );

  return {
    proposal,
    innerInstructionSetHash,
    wrapped,
    groups: { create, inserts, signOff },
  };
}
