/**
 * Propose builder — the one call that turns an inner instruction set into
 * the full wrapped proposal ceremony (spec 6.3/12.3). Encodes the
 * conventions the mainnet gate runs hand-rolled:
 *
 * - the inner set is wrapped through the ExecutionAdapter (Squads custody
 *   chain), one ProposalTransaction per wrapped instruction (CU isolation);
 *   optional direct legs (D-022) follow the chain, one ProposalTransaction
 *   each, signed by the native treasury at execution;
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
import { unwrap, wrap, wrapBuffered, type WrapContext } from "./execution-adapter";

const PROGRAM_VERSION = 3;
/**
 * Max VaultTransactionCreate data that still fits a governance
 * InsertTransaction inside the 1232-byte transaction limit (measured:
 * 732 bytes of create data made a 1420-byte insert tx). Above this the
 * builder switches to the buffered Squads chain.
 */
const PLAIN_CREATE_DATA_BUDGET = 500;

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
  /**
   * Direct legs (D-022): inserted as ProposalTransactions AFTER the
   * custody chain, one per instruction, signed by the governance native
   * treasury at execution time (no Squads wrapping). For account-heavy
   * venue instructions (e.g. a PumpSwap buy: ~26 accounts) whose Squads
   * execute insert cannot fit the transaction limit. The INV-9 hash and
   * unwrap() cover them.
   */
  directIxs?: TransactionInstruction[];
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
  /**
   * One entry per ProposalTransaction inserted on-chain: the
   * ExecutionAdapter chain, then any direct legs.
   */
  wrapped: TransactionInstruction[];
  /** True when the inner set was too large for a plain wrap (buffered chain). */
  buffered: boolean;
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
  const directIxs = p.directIxs ?? [];
  // A proposal needs SOMETHING to execute; a direct-leg-only proposal is
  // legitimate (e.g. setParam: a single governance-signed config change).
  if (p.innerIxs.length === 0 && directIxs.length === 0) {
    throw new Error("buildProposeIxs: inner instruction set is empty");
  }
  // Account-heavy inner sets overflow the InsertTransaction carrying the
  // plain VaultTransactionCreate — switch to the buffered Squads chain.
  let chain: TransactionInstruction[] = [];
  let buffered = false;
  if (p.innerIxs.length > 0) {
    const plain = wrap(p.innerIxs, p.wrapCtx);
    buffered = plain[0]!.data.length > PLAIN_CREATE_DATA_BUDGET;
    chain = buffered ? wrapBuffered(p.innerIxs, p.wrapCtx).ixs : plain;
  }
  const wrapped = [...chain, ...directIxs];
  // INV-9 covers the full EFFECTIVE set: hash what unwrap() recovers from
  // the chain, not the raw input. The Squads message format unifies an
  // account's privileges message-wide (signer/writable = max across the
  // inner set — runtime semantics), so hashing the raw inner ixs would
  // permanently mismatch the chain-recomputed hash whenever the same
  // account appears with conflicting flags (found by the Stage 2 fuzz
  // suite, D-027). Hashing the round-tripped form makes publish-time and
  // chain-side hashes identical BY CONSTRUCTION.
  const innerInstructionSetHash = computeInstructionSetHash([
    ...(chain.length > 0 ? unwrap(chain, p.wrapCtx) : []),
    ...directIxs,
  ]);

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
    buffered,
    groups: { create, inserts, signOff },
  };
}
