/**
 * Fully client-side governance actions (decentralized): build the unsigned tx
 * in the BROWSER via the SDK resolvers, sign with the wallet, and submit
 * directly to an RPC — no backend in the path. Same build → sign → submit shape
 * as the API flow (governance-actions.ts), but the build + submit hit the chain
 * directly instead of the server.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { resolveCastVoteTx, resolveDepositTx } from "@daofun/sdk";
import type { FlowState, SignerLike } from "./governance-actions";
import { base64ToBytes } from "./wallet-standard";

export interface ClientFlowOpts {
  signer: SignerLike;
  connection: Connection;
  onState?: (s: FlowState) => void;
}

/** build (SDK, in-browser) -> sign (wallet) -> submit (RPC) -> confirm. */
export async function runClientFlow(
  build: () => Promise<string>,
  opts: ClientFlowOpts,
): Promise<FlowState> {
  const step = (s: FlowState) => {
    opts.onState?.(s);
    return s;
  };
  try {
    step({ phase: "building" });
    const unsigned = await build();

    step({ phase: "signing" });
    const signed = await opts.signer.signTransaction(unsigned);

    step({ phase: "submitting" });
    const signature = await opts.connection.sendRawTransaction(
      base64ToBytes(signed),
      { skipPreflight: false },
    );
    await opts.connection.confirmTransaction(signature, "confirmed");
    return step({ phase: "done", signature });
  } catch (e) {
    return step({ phase: "error", error: (e as Error).message });
  }
}

export function castVoteClientFlow(
  p: { proposal: string; approve: boolean },
  opts: ClientFlowOpts,
): Promise<FlowState> {
  return runClientFlow(
    () =>
      resolveCastVoteTx(opts.connection, {
        proposal: new PublicKey(p.proposal),
        wallet: new PublicKey(opts.signer.address),
        approve: p.approve,
      }).then((r) => r.txBase64),
    opts,
  );
}

export function depositClientFlow(
  p: { realm: string; governingTokenMint: string; amount: string },
  opts: ClientFlowOpts,
): Promise<FlowState> {
  return runClientFlow(
    () =>
      resolveDepositTx(opts.connection, {
        realm: new PublicKey(p.realm),
        governingTokenMint: new PublicKey(p.governingTokenMint),
        wallet: new PublicKey(opts.signer.address),
        amount: BigInt(p.amount),
      }).then((r) => r.txBase64),
    opts,
  );
}
