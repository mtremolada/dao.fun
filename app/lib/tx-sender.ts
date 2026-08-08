/**
 * The transaction send pipeline — one state machine for every wallet
 * transaction in the app (trades and launches). It exists to solve the devnet
 * broadcast trap: `signAndSendTransaction` broadcasts on the WALLET's selected
 * network, which the dapp cannot force. So on a non-mainnet build the default
 * path is sign-only + dapp-side broadcast to OUR RPC — the one deterministic
 * way to guarantee the transaction lands on the cluster we intend — and every
 * send is verified by polling OUR RPC for the signature.
 *
 * All I/O is behind seams (`SendRpc`, `SigningWallet`, `sleep`) so the whole
 * machine is unit-tested with fakes, no chain required.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { FeeEstimator } from "./fees";

export type SendPhase =
  | "preflight"
  | "building"
  | "signing"
  | "broadcasting"
  | "confirming"
  | "confirmed"
  | "failed";

export type FailReason =
  | "user-rejected"
  | "program-error"
  | "expired"
  | "wrong-cluster"
  | "rpc-error";

export interface SendState {
  phase: SendPhase;
  signature?: string;
  reason?: FailReason;
  message?: string;
}

export interface SigningWallet {
  address: string;
  /** Clusters the wallet account advertises (necessary, not sufficient). */
  chains?: readonly string[] | undefined;
  /** Sign-only — the preferred devnet path (we broadcast). Returns wire bytes. */
  signOnly?: ((tx: Transaction) => Promise<Uint8Array>) | undefined;
  /** Wallet signs AND broadcasts on its own network — fallback only. */
  signAndSend?: ((tx: Transaction) => Promise<string>) | undefined;
}

/** The subset of web3 Connection the pipeline uses (real Connection satisfies it). */
export interface SendRpc {
  getLatestBlockhash(commitment: string): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  /**
   * Legacy-Transaction form: NO config argument. web3's Connection throws
   * "Invalid arguments" if a legacy tx is paired with a config object (that
   * overload exists only for VersionedTransaction); called with the tx alone
   * it simulates unsigned with sigVerify off — exactly what we want.
   */
  simulateTransaction(
    tx: Transaction,
  ): Promise<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>;
  sendRawTransaction(raw: Uint8Array | Buffer, opts?: { skipPreflight?: boolean; maxRetries?: number }): Promise<string>;
  getSignatureStatuses(sigs: string[]): Promise<{ value: ({ confirmationStatus: string | null; err: unknown } | null)[] }>;
  getBlockHeight(commitment: string): Promise<number>;
}

export interface SendParams {
  instructions: TransactionInstruction[];
  wallet: SigningWallet;
  connection: SendRpc;
  chainId: string;
  feeEstimator: FeeEstimator;
  onState?: ((s: SendState) => void) | undefined;
  /** Decode a program error code/log into a sentence (the SDK error map). */
  explainError?: ((input: number | string) => string | undefined) | undefined;
  /** Prefer sign-and-broadcast (mainnet). Default false → sign-only path. */
  preferWalletBroadcast?: boolean | undefined;
  /** Extra keypairs that must co-sign (e.g. a fresh mint on create_coin). */
  extraSigners?: Keypair[] | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  pollLimit?: number | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isRejection = (m: string) => /reject|denied|declined|cancell?ed/i.test(m);

export async function sendTransaction(p: SendParams): Promise<SendState> {
  const emit = (s: SendState): SendState => {
    p.onState?.(s);
    return s;
  };
  const sleep = p.sleep ?? defaultSleep;

  // --- preflight: wallet-cluster guard ---
  emit({ phase: "preflight" });
  if (p.wallet.chains && p.wallet.chains.length > 0 && !p.wallet.chains.includes(p.chainId)) {
    return emit({
      phase: "failed",
      reason: "wrong-cluster",
      message: `Your wallet isn't set to ${p.chainId}. Switch its network, then try again.`,
    });
  }

  // --- building: blockhash, compute budget, simulate ---
  emit({ phase: "building" });
  let blockhash: string;
  let lastValidBlockHeight: number;
  try {
    ({ blockhash, lastValidBlockHeight } = await p.connection.getLatestBlockhash("confirmed"));
  } catch (e) {
    return emit({ phase: "failed", reason: "rpc-error", message: (e as Error).message });
  }

  const feePayer = new PublicKey(p.wallet.address);
  const microLamports = await p.feeEstimator.priorityFeeMicroLamports();
  const build = (unitLimit: number): Transaction => {
    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }));
    for (const ix of p.instructions) tx.add(ix);
    tx.feePayer = feePayer;
    tx.recentBlockhash = blockhash;
    return tx;
  };

  let unitLimit = 400_000;
  try {
    const sim = await p.connection.simulateTransaction(build(1_400_000));
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).join("\n");
      const explained = p.explainError?.(logs);
      return emit({
        phase: "failed",
        reason: "program-error",
        message: explained ?? `Transaction simulation failed: ${JSON.stringify(sim.value.err)}`,
      });
    }
    if (sim.value.unitsConsumed && sim.value.unitsConsumed > 0) {
      unitLimit = Math.min(1_400_000, Math.ceil(sim.value.unitsConsumed * 1.1));
    }
  } catch (e) {
    return emit({ phase: "failed", reason: "rpc-error", message: (e as Error).message });
  }
  const tx = build(unitLimit);
  // Co-signers (e.g. a fresh mint) sign before the wallet; the wallet then
  // adds the fee-payer signature over the same message.
  if (p.extraSigners && p.extraSigners.length > 0) tx.partialSign(...p.extraSigners);

  // --- signing ---
  emit({ phase: "signing" });
  const useWalletBroadcast = p.preferWalletBroadcast && !!p.wallet.signAndSend;

  let signature = "";
  let raw: Uint8Array | null = null;
  try {
    if (useWalletBroadcast) {
      signature = await p.wallet.signAndSend!(tx);
    } else if (p.wallet.signOnly) {
      raw = await p.wallet.signOnly(tx);
    } else if (p.wallet.signAndSend) {
      signature = await p.wallet.signAndSend(tx);
    } else {
      return emit({ phase: "failed", reason: "rpc-error", message: "wallet cannot sign transactions" });
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return emit({
      phase: "failed",
      reason: isRejection(msg) ? "user-rejected" : "rpc-error",
      message: msg,
    });
  }

  // --- broadcasting (sign-only path) ---
  if (raw) {
    emit({ phase: "broadcasting" });
    try {
      signature = await p.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      const explained = p.explainError?.(msg);
      return emit({ phase: "failed", reason: explained ? "program-error" : "rpc-error", message: explained ?? msg });
    }
  }

  // --- confirming: landing verification on OUR rpc ---
  emit({ phase: "confirming", signature: signature! });
  const limit = p.pollLimit ?? 40;
  for (let i = 0; i < limit; i += 1) {
    const status = (await p.connection.getSignatureStatuses([signature!])).value[0];
    if (status) {
      if (status.err) {
        const explained = p.explainError?.(JSON.stringify(status.err));
        return emit({ phase: "failed", reason: "program-error", signature: signature!, message: explained ?? "transaction failed on chain" });
      }
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return emit({ phase: "confirmed", signature: signature! });
      }
    }
    const height = await p.connection.getBlockHeight("confirmed");
    if (height > lastValidBlockHeight) {
      // Expired. If the WALLET broadcast (fallback path) and the signature
      // never appeared on our RPC, it most likely landed on another cluster —
      // the classic devnet-vs-mainnet mismatch.
      if (useWalletBroadcast && !status) {
        return emit({
          phase: "failed",
          reason: "wrong-cluster",
          signature: signature!,
          message: "The transaction never appeared on this cluster. Set your wallet to the correct network and retry.",
        });
      }
      return emit({ phase: "failed", reason: "expired", signature: signature!, message: "The transaction expired. Please try again." });
    }
    if (raw) {
      // Rebroadcast the SAME signed bytes; never re-sign under a live blockhash.
      try {
        await p.connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
      } catch {
        /* transient; keep polling */
      }
    }
    await sleep(1500);
  }
  return emit({ phase: "failed", reason: "expired", signature: signature!, message: "Timed out waiting for confirmation." });
}
