/**
 * Permissionless proposal execution, client-side (no server). Once a proposal
 * has Succeeded and its hold-up has elapsed, ANYONE may crank execution
 * (spec 12.1: what passed executes, byte-identical) — the executor only pays
 * the tx fee; no governance authority is needed. We re-read each
 * ProposalTransaction FROM CHAIN and replay it through SPL Governance's
 * withExecuteTransaction, in order, signed + sent by the connected wallet.
 */
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  ProposalTransaction,
  getGovernanceAccount,
  getProposal,
  getProposalTransactionAddress,
  withExecuteTransaction,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "./chain";
import type { WalletSender } from "./wallet-sender";

const PROGRAM_VERSION = 3;
// Production tx hygiene (D-019): governance execute -> Squads execute -> inner
// CPIs stack beyond the 200k default; the mainnet runs used 400k.
const EXECUTE_CU = 400_000;

export interface ExecuteStep {
  index: number;
  total: number;
  status: "running" | "done" | "error";
  signature?: string;
  error?: string;
}

/**
 * Execute every ProposalTransaction in order. Each is its own wallet-signed
 * transaction (the executor is the only signer). Account-heavy legs (e.g. AMM
 * actions, D-022) can exceed the 1232-byte limit and need a v0+ALT send the
 * static client does not yet build — those surface a clear error here rather
 * than a cryptic failure.
 */
export async function runExecute(
  connection: Connection,
  sender: WalletSender,
  proposal: PublicKey,
  onStep: (s: ExecuteStep) => void,
): Promise<string[]> {
  const wallet = new PublicKey(sender.address);
  const prop = await getProposal(connection, proposal);
  const governance = prop.account.governance;
  const count =
    prop.account.options[0]?.instructionsNextIndex ??
    prop.account.instructionsNextIndex ??
    0;
  if (count === 0) throw new Error("proposal has no executable instructions");

  const signatures: string[] = [];
  for (let index = 0; index < count; index++) {
    onStep({ index, total: count, status: "running" });
    try {
      const addr = await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        proposal,
        0,
        index,
      );
      const pt = await getGovernanceAccount(connection, addr, ProposalTransaction);
      const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_CU })];
      await withExecuteTransaction(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        governance,
        proposal,
        addr,
        // The ProposalTransaction stores its instructions as InstructionData
        // already — replay them verbatim (this IS the INV-9 guarantee).
        pt.account.instructions,
      );
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash("confirmed")
      ).blockhash;
      const sig = await sender.signAndSend(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      signatures.push(sig);
      onStep({ index, total: count, status: "done", signature: sig });
    } catch (e) {
      const msg = (e as Error).message;
      onStep({
        index,
        total: count,
        status: "error",
        error: /too large/i.test(msg)
          ? "this proposal's instruction is account-heavy and needs a lookup-table send (not yet supported in the static UI)"
          : msg,
      });
      throw e;
    }
  }
  return signatures;
}
