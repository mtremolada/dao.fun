/**
 * Client-side proposal creation (no server). Resolves the full create context
 * from chain via the SDK (proven on real binaries by
 * tests/propose-grant.integration.test.ts), then signs + sends each group —
 * create, each insert, sign-off — through the connected wallet, in order.
 * Once sign-off lands the proposal is in voting; the existing proposal page
 * handles vote -> hold-up -> permissionless execute.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { resolveCreateGrantProposal } from "@daofun/sdk/proposal-create";
import type { WalletSender } from "./wallet-sender";

export interface ProposeStep {
  step: string;
  status: "running" | "done" | "error";
  signature?: string;
  error?: string;
}

export interface GrantProposalInput {
  mint: string;
  vault: string;
  multisig: string;
  recipient: string;
  lamports: bigint;
  name: string;
}

export interface ProposeResult {
  proposal: string;
  signatures: string[];
}

export async function runCreateGrantProposal(
  connection: Connection,
  sender: WalletSender,
  input: GrantProposalInput,
  onStep: (s: ProposeStep) => void,
): Promise<ProposeResult> {
  const wallet = new PublicKey(sender.address);
  const made = await resolveCreateGrantProposal(connection, {
    mint: new PublicKey(input.mint),
    proposer: wallet,
    vault: new PublicKey(input.vault),
    multisig: new PublicKey(input.multisig),
    recipient: new PublicKey(input.recipient),
    lamports: input.lamports,
    name: input.name,
  });

  const signatures: string[] = [];
  async function send(step: string, ixs: Transaction["instructions"]): Promise<void> {
    onStep({ step, status: "running" });
    try {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash("confirmed")
      ).blockhash;
      const sig = await sender.signAndSend(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      signatures.push(sig);
      onStep({ step, status: "done", signature: sig });
    } catch (e) {
      onStep({ step, status: "error", error: (e as Error).message });
      throw e;
    }
  }

  await send("Create proposal", made.groups.create);
  const n = made.groups.inserts.length;
  for (const [i, group] of made.groups.inserts.entries()) {
    await send(`Insert instruction ${i + 1}/${n}`, group);
  }
  await send("Sign off — opens voting", made.groups.signOff);

  return { proposal: made.proposal.toBase58(), signatures };
}
