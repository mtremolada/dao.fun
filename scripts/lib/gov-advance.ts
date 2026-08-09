/**
 * Advancing a governance proposal through the legs a live cluster gates on
 * TIME: finalize once the voting window closes, then execute once the
 * instruction hold-up elapses.
 *
 * This lives in a module rather than in a script because two callers need it
 * and they must not drift: `devnet-guarded-advance.ts` finishes the
 * production-params proposal days later, and `devnet-guarded-run.ts --fast`
 * drives the same two legs within one run against a short-window governance.
 * If the fast run proved a DIFFERENT code path than the one that finishes the
 * real proposal, it would prove nothing about it.
 *
 * Everything is read from chain — the caller supplies only a proposal address.
 * Calling early is safe and free: the timing legs report what is still pending
 * rather than attempting anything.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  Governance,
  GovernanceAccountParser,
  type InstructionData,
  Proposal,
  ProposalState,
  ProposalTransaction,
  createInstructionData,
  getProposalTransactionAddress,
  withExecuteTransaction,
  withFinalizeVote,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../../packages/sdk/src/constants";

export const PROGRAM_VERSION = 3;

/**
 * spl-governance's parser is typed around its own class union, which does not
 * survive a generic parameter; the cast is at the boundary and the return type
 * is what callers actually get.
 */
export async function readAccount<T>(
  connection: Connection,
  address: PublicKey,
  cls: unknown,
): Promise<T> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`no account at ${address.toBase58()}`);
  return GovernanceAccountParser(
    cls as Parameters<typeof GovernanceAccountParser>[0],
  )(address, info).account as T;
}

export interface ProposalContext {
  proposal: Proposal;
  proposalAddress: PublicKey;
  governance: Governance;
  governanceAddress: PublicKey;
  realm: PublicKey;
  /** Unix seconds when the voting window closes (0 before sign-off). */
  votingEndsAt: number;
  /** Unix seconds when a Succeeded proposal's transactions become executable. */
  executableAt: number;
}

export async function readProposalContext(
  connection: Connection,
  proposalAddress: PublicKey,
): Promise<ProposalContext> {
  const proposal = await readAccount<Proposal>(connection, proposalAddress, Proposal);
  const governanceAddress = proposal.governance;
  const governance = await readAccount<Governance>(
    connection,
    governanceAddress,
    Governance,
  );
  // votingAt is stamped at sign-off, not at creation; the window is the
  // governance's base time, so a proposal that was never signed off has no
  // window at all rather than one that started at the epoch.
  const votingAt = Number(proposal.votingAt ?? 0);
  const votingCompletedAt = Number(proposal.votingCompletedAt ?? 0);
  return {
    proposal,
    proposalAddress,
    governance,
    governanceAddress,
    realm: governance.realm,
    votingEndsAt: votingAt === 0 ? 0 : votingAt + governance.config.baseVotingTime,
    executableAt:
      votingCompletedAt === 0
        ? 0
        : votingCompletedAt + governance.config.minInstructionHoldUpTime,
  };
}

/**
 * The executable instruction sets attached to a proposal, one per
 * ProposalTransaction, in index order (option 0 — single-choice).
 *
 * Exposed separately from `advanceProposal` so a caller can attempt an
 * execution the hold-up should REFUSE, which is the only way to prove the
 * hold-up is enforced rather than merely configured.
 */
export async function buildExecuteTransactions(
  connection: Connection,
  ctx: ProposalContext,
  maxIndex = 16,
): Promise<{ index: number; address: PublicKey; ixs: TransactionInstruction[] }[]> {
  const out: { index: number; address: PublicKey; ixs: TransactionInstruction[] }[] = [];
  for (let i = 0; i < maxIndex; i++) {
    const ptAddr = await getProposalTransactionAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      ctx.proposalAddress,
      0,
      i,
    );
    const info = await connection.getAccountInfo(ptAddr);
    if (!info) break;
    const pt = GovernanceAccountParser(ProposalTransaction)(ptAddr, info).account;
    const inner = pt.getAllInstructions().map((d: InstructionData) =>
      createInstructionData(
        new TransactionInstruction({
          programId: d.programId,
          keys: d.accounts.map((a) => ({
            pubkey: a.pubkey,
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(d.data),
        }),
      ),
    );
    const ixs: TransactionInstruction[] = [];
    await withExecuteTransaction(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      ctx.governanceAddress,
      ctx.proposalAddress,
      ptAddr,
      inner,
    );
    out.push({ index: i, address: ptAddr, ixs });
  }
  return out;
}

export type AdvanceOutcome =
  | { step: "waiting-vote"; secondsLeft: number; endsAt: number }
  | { step: "finalized"; signature: string; state: ProposalState }
  | { step: "waiting-holdup"; secondsLeft: number; executableAt: number }
  | { step: "executed"; signatures: string[]; state: ProposalState }
  | { step: "nothing"; state: ProposalState };

/**
 * Move the proposal on by whatever step time has made possible.
 *
 *   Voting    + window elapsed   -> finalize
 *   Succeeded + hold-up elapsed  -> execute every attached transaction
 *   otherwise                    -> report what is still pending
 */
export async function advanceProposal(
  connection: Connection,
  payer: Keypair,
  proposalAddress: PublicKey,
  opts: { now?: number } = {},
): Promise<{ ctx: ProposalContext; outcome: AdvanceOutcome }> {
  const ctx = await readProposalContext(connection, proposalAddress);
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  const send = (ixs: TransactionInstruction[]) =>
    sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...ixs,
      ),
      [payer],
      { commitment: "confirmed" },
    );

  if (ctx.proposal.state === ProposalState.Voting) {
    if (now < ctx.votingEndsAt) {
      return {
        ctx,
        outcome: {
          step: "waiting-vote",
          secondsLeft: ctx.votingEndsAt - now,
          endsAt: ctx.votingEndsAt,
        },
      };
    }
    const ixs: TransactionInstruction[] = [];
    await withFinalizeVote(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      ctx.realm,
      ctx.governanceAddress,
      proposalAddress,
      // The proposal is OWNED by the gate's council record — passing the
      // proposer's would be refused with "Invalid Proposal Owner".
      ctx.proposal.tokenOwnerRecord,
      ctx.proposal.governingTokenMint,
    );
    const signature = await send(ixs);
    const after = await readAccount<Proposal>(connection, proposalAddress, Proposal);
    return { ctx, outcome: { step: "finalized", signature, state: after.state } };
  }

  if (ctx.proposal.state === ProposalState.Succeeded) {
    if (now < ctx.executableAt) {
      return {
        ctx,
        outcome: {
          step: "waiting-holdup",
          secondsLeft: ctx.executableAt - now,
          executableAt: ctx.executableAt,
        },
      };
    }
    const signatures: string[] = [];
    for (const t of await buildExecuteTransactions(connection, ctx)) {
      signatures.push(await send(t.ixs));
    }
    const after = await readAccount<Proposal>(connection, proposalAddress, Proposal);
    return { ctx, outcome: { step: "executed", signatures, state: after.state } };
  }

  return { ctx, outcome: { step: "nothing", state: ctx.proposal.state } };
}

/** Human-readable one-liner for a script's stdout. */
export function describeOutcome(o: AdvanceOutcome): string {
  switch (o.step) {
    case "waiting-vote":
      return (
        `still VOTING — ${Math.ceil(o.secondsLeft / 3600)}h to go ` +
        `(window ends ${new Date(o.endsAt * 1000).toISOString()}). Nothing to do yet.`
      );
    case "finalized":
      return `finalize   ${o.signature}\nstate      ${ProposalState[o.state]}`;
    case "waiting-holdup":
      return (
        `SUCCEEDED, in hold-up — ${Math.ceil(o.secondsLeft / 60)}min to go ` +
        `(executable ${new Date(o.executableAt * 1000).toISOString()}).`
      );
    case "executed":
      return (
        o.signatures.map((s, i) => `execute[${i}] ${s}`).join("\n") +
        `\nstate      ${ProposalState[o.state]}`
      );
    case "nothing":
      return `nothing to advance from ${ProposalState[o.state]}.`;
  }
}
