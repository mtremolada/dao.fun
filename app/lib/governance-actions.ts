/**
 * Browser governance flows — fully client-side, no server. Each flow builds
 * the transaction in the browser (over the user's RPC), then hands it to the
 * connected wallet to sign AND send through the wallet's own RPC. The
 * builders are injectable so the state machine is unit-tested offline.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import type { WalletSender } from "./wallet-sender";
import { buildCastVoteTx, buildDepositTx } from "./vote";

export type FlowPhase = "building" | "sending" | "done" | "error";

export interface FlowState {
  phase: FlowPhase;
  signature?: string;
  error?: string;
}

export interface FlowOpts {
  connection: Connection;
  sender: WalletSender;
  onState?: (s: FlowState) => void;
  /** Test seam: override the builder so the flow runs without an RPC. */
  buildTx?: (connection: Connection, wallet: PublicKey) => Promise<Transaction>;
}

async function runFlow(
  defaultBuild: (connection: Connection, wallet: PublicKey) => Promise<Transaction>,
  opts: FlowOpts,
): Promise<FlowState> {
  const step = (s: FlowState) => {
    opts.onState?.(s);
    return s;
  };
  try {
    step({ phase: "building" });
    const wallet = new PublicKey(opts.sender.address);
    const build = opts.buildTx ?? defaultBuild;
    const tx = await build(opts.connection, wallet);

    step({ phase: "sending" });
    const signature = await opts.sender.signAndSend(tx, opts.connection);
    return step({ phase: "done", signature });
  } catch (e) {
    return step({ phase: "error", error: (e as Error).message });
  }
}

export function castVoteFlow(
  p: { proposal: string; approve: boolean },
  opts: FlowOpts,
): Promise<FlowState> {
  const proposal = (() => {
    try {
      return new PublicKey(p.proposal);
    } catch {
      return null;
    }
  })();
  return runFlow((connection, wallet) => {
    if (!proposal) throw new Error("invalid proposal address");
    return buildCastVoteTx(connection, proposal, wallet, p.approve);
  }, opts);
}

export function depositFlow(
  p: { realm: string; governingTokenMint: string; amount: string },
  opts: FlowOpts,
): Promise<FlowState> {
  return runFlow((connection, wallet) => {
    const realm = new PublicKey(p.realm);
    const mint = new PublicKey(p.governingTokenMint);
    return buildDepositTx(connection, realm, mint, wallet, BigInt(p.amount));
  }, opts);
}
