"use client";

/**
 * Browser governance actions (D-033, supersedes the D-028 server seam).
 *
 * build -> sign -> submit, fully client-side: the SDK's GovernanceTxSource
 * builds the UNSIGNED transaction against the user's RPC, the wallet
 * (wallet-standard) signs raw bytes, and the SAME source submits. The wallet
 * is the only signer and fee payer — no server, no platform key, anywhere in
 * the path. The source is injected, so the state machine is unit-tested
 * offline against a fake.
 */
import { PublicKey } from "@solana/web3.js";
import type { GovernanceTxSource } from "@daofun/sdk/tx-builder";

export interface SignerLike {
  /** base58 wallet address. */
  address: string;
  /** Signs a base64 unsigned tx, returns the base64 signed tx. */
  signTransaction(txBase64: string): Promise<string>;
}

export type FlowPhase = "building" | "signing" | "submitting" | "done" | "error";

export interface FlowState {
  phase: FlowPhase;
  signature?: string;
  error?: string;
}

export interface FlowOpts {
  signer: SignerLike;
  source: GovernanceTxSource;
  onState?: (s: FlowState) => void;
}

/** build (unsigned tx from the source) -> sign (wallet) -> submit (source). */
async function runFlow(
  build: () => Promise<{ txBase64: string }>,
  opts: FlowOpts,
): Promise<FlowState> {
  const step = (s: FlowState) => {
    opts.onState?.(s);
    return s;
  };
  try {
    step({ phase: "building" });
    const { txBase64 } = await build();
    if (!txBase64) throw new Error("builder returned no transaction");

    step({ phase: "signing" });
    const signed = await opts.signer.signTransaction(txBase64);

    step({ phase: "submitting" });
    const { signature } = await opts.source.submit(signed);
    return step({ phase: "done", signature });
  } catch (e) {
    return step({ phase: "error", error: (e as Error).message });
  }
}

export function castVoteFlow(
  p: { proposal: string; approve: boolean },
  opts: FlowOpts,
): Promise<FlowState> {
  return runFlow(
    () =>
      opts.source.castVoteTx({
        proposal: new PublicKey(p.proposal),
        wallet: new PublicKey(opts.signer.address),
        approve: p.approve,
      }),
    opts,
  );
}

export function depositFlow(
  p: {
    realm: string;
    governingTokenMint: string;
    amount: string;
    /** Owner program of the mint (Token vs Token-2022); auto-detected by the UI. */
    tokenProgram?: string;
  },
  opts: FlowOpts,
): Promise<FlowState> {
  return runFlow(
    () =>
      opts.source.depositTx({
        realm: new PublicKey(p.realm),
        governingTokenMint: new PublicKey(p.governingTokenMint),
        wallet: new PublicKey(opts.signer.address),
        amount: BigInt(p.amount),
        ...(p.tokenProgram ? { tokenProgram: new PublicKey(p.tokenProgram) } : {}),
      }),
    opts,
  );
}
