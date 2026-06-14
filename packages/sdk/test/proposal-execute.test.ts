/**
 * buildExecuteProposalIxs — the "claimable after a passing vote" primitive
 * (the execute counterpart to buildProposeIxs). Written before the code.
 *
 * Governance reimbursements are PULL, not push: once the DAO's vote carries,
 * the proposal sits in `Succeeded` and SPL Governance lets ANYONE submit
 * ExecuteTransaction to run its (already-authorized) transfer. This builder
 * is the gate: it refuses to produce a claim tx until the vote has passed,
 * skips legs that already executed (idempotent resume), and bumps CU because
 * governance -> Squads -> inner CPIs stack past the 200k default.
 *
 * The on-chain correctness of withExecuteTransaction against the deployed
 * fork is covered by the bankrun integration suite (executeAll); this unit
 * pins the GATING and assembly logic.
 */
import { describe, expect, it } from "vitest";
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { InstructionExecutionStatus, ProposalState } from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../src/constants";
import {
  buildExecuteProposalIxs,
  type ExecuteLeg,
} from "../src/proposal";

const governance = Keypair.generate().publicKey;
const proposal = Keypair.generate().publicKey;

/** A plausible wrapped leg: any real instruction works for createInstructionData. */
function leg(executionStatus: InstructionExecutionStatus): ExecuteLeg {
  return {
    proposalTransaction: Keypair.generate().publicKey,
    instruction: SystemProgram.transfer({
      fromPubkey: Keypair.generate().publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    }),
    executionStatus,
  };
}

function legs(n: number, statuses: InstructionExecutionStatus[] = []): ExecuteLeg[] {
  return Array.from({ length: n }, (_, i) =>
    leg(statuses[i] ?? InstructionExecutionStatus.None),
  );
}

describe("buildExecuteProposalIxs — vote gate", () => {
  it.each([
    [ProposalState.Draft],
    [ProposalState.SigningOff],
    [ProposalState.Voting],
  ])("refuses to build a claim before the vote ends (%s -> not-ready)", async (state) => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state,
      legs: legs(4),
    });
    expect(r.status).toBe("not-ready");
    expect(r.groups).toHaveLength(0);
  });

  it.each([
    [ProposalState.Defeated],
    [ProposalState.Vetoed],
    [ProposalState.Cancelled],
  ])("never makes a failed proposal claimable (%s -> rejected)", async (state) => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state,
      legs: legs(4),
    });
    expect(r.status).toBe("rejected");
    expect(r.groups).toHaveLength(0);
  });

  it("reports a fully-executed proposal as already claimed", async () => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state: ProposalState.Completed,
      legs: legs(4, Array(4).fill(InstructionExecutionStatus.Success)),
    });
    expect(r.status).toBe("claimed");
    expect(r.groups).toHaveLength(0);
  });
});

describe("buildExecuteProposalIxs — claim assembly", () => {
  it("builds one CU-bumped governance execute tx per leg once Succeeded", async () => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state: ProposalState.Succeeded,
      legs: legs(4),
    });
    expect(r.status).toBe("claimable");
    expect(r.groups).toHaveLength(4);
    for (const group of r.groups) {
      expect(group).toHaveLength(2);
      expect(group[0]!.programId.equals(ComputeBudgetProgram.programId)).toBe(true);
      expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(group[0]!).units).toBe(
        400_000,
      );
      expect(group[1]!.programId.equals(SPL_GOVERNANCE_PROGRAM_ID)).toBe(true);
    }
  });

  it("skips legs that already executed (idempotent resume)", async () => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state: ProposalState.Executing, // partially executed, resuming
      legs: legs(4, [
        InstructionExecutionStatus.Success,
        InstructionExecutionStatus.Success,
        InstructionExecutionStatus.None,
        InstructionExecutionStatus.None,
      ]),
    });
    expect(r.status).toBe("claimable");
    expect(r.groups).toHaveLength(2); // only the two unexecuted legs
  });

  it("honors a CU override", async () => {
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state: ProposalState.Succeeded,
      legs: legs(1),
      computeUnitLimit: 250_000,
    });
    expect(
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(r.groups[0]![0]!).units,
    ).toBe(250_000);
  });

  it("targets the leg's own ProposalTransaction PDA in each execute", async () => {
    const ls = legs(2);
    const r = await buildExecuteProposalIxs({
      governance,
      proposal,
      state: ProposalState.Succeeded,
      legs: ls,
    });
    // The ProposalTransaction PDA is a key of its execute ix (account-order
    // independent assertion: it must appear).
    for (const [i, group] of r.groups.entries()) {
      const keys = group[1]!.keys.map((k: { pubkey: PublicKey }) => k.pubkey.toBase58());
      expect(keys).toContain(ls[i]!.proposalTransaction.toBase58());
    }
  });
});
