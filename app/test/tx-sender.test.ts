/**
 * The send pipeline — the devnet-correctness core. Fakes for the RPC and the
 * wallet, so every phase transition and failure mode is checked without a
 * chain. The load-bearing cases: the wallet-cluster preflight, the landing
 * verification that turns a never-appearing signature into a wrong-cluster
 * error, and expiry that asks for a rebuild rather than a silent re-sign.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { sendTransaction, type SendRpc, type SigningWallet } from "../lib/tx-sender";
import { ConstantFeeEstimator } from "../lib/fees";

const payer = Keypair.generate();
const ix = () =>
  SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 });

function rpc(over: Partial<SendRpc> = {}): SendRpc {
  return {
    getLatestBlockhash: async () => ({ blockhash: "1".repeat(32), lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 20_000 } }),
    sendRawTransaction: async () => "sigABC",
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    getBlockHeight: async () => 50,
    ...over,
  };
}

const signOnlyWallet = (chains?: string[]): SigningWallet => ({
  address: payer.publicKey.toBase58(),
  chains,
  signOnly: async (tx: Transaction) => {
    tx.sign(payer);
    return tx.serialize();
  },
});

const base = {
  instructions: [ix()],
  chainId: "solana:devnet",
  feeEstimator: new ConstantFeeEstimator(10_000),
  sleep: async () => {},
};

describe("sendTransaction", () => {
  it("walks preflight→…→confirmed on the sign-only path", async () => {
    const phases: string[] = [];
    const r = await sendTransaction({
      ...base,
      wallet: signOnlyWallet(["solana:devnet"]),
      connection: rpc(),
      onState: (s) => phases.push(s.phase),
    });
    expect(r.phase).toBe("confirmed");
    expect(r.signature).toBe("sigABC");
    expect(phases).toEqual(["preflight", "building", "signing", "broadcasting", "confirming", "confirmed"]);
  });

  it("refuses at preflight when the wallet doesn't advertise the target cluster", async () => {
    const r = await sendTransaction({
      ...base,
      wallet: signOnlyWallet(["solana:mainnet"]),
      connection: rpc(),
    });
    expect(r).toMatchObject({ phase: "failed", reason: "wrong-cluster" });
  });

  it("decodes a program error from simulation and never signs", async () => {
    let signed = false;
    const wallet: SigningWallet = {
      address: payer.publicKey.toBase58(),
      chains: ["solana:devnet"],
      signOnly: async (tx) => {
        signed = true;
        return tx.serialize({ requireAllSignatures: false });
      },
    };
    const r = await sendTransaction({
      ...base,
      wallet,
      connection: rpc({
        simulateTransaction: async () => ({
          value: { err: { Custom: 6003 }, logs: ["Program log: custom program error: 0x1773"], unitsConsumed: 0 },
        }),
      }),
      explainError: (input) => (String(input).includes("0x1773") ? "Trading is closed." : undefined),
    });
    expect(r).toMatchObject({ phase: "failed", reason: "program-error", message: "Trading is closed." });
    expect(signed).toBe(false);
  });

  it("maps a user rejection to user-rejected", async () => {
    const wallet: SigningWallet = {
      address: payer.publicKey.toBase58(),
      chains: ["solana:devnet"],
      signOnly: async () => {
        throw new Error("User rejected the request");
      },
    };
    const r = await sendTransaction({ ...base, wallet, connection: rpc() });
    expect(r).toMatchObject({ phase: "failed", reason: "user-rejected" });
  });

  it("expires (asks for rebuild) when the blockhash passes without confirmation", async () => {
    const r = await sendTransaction({
      ...base,
      wallet: signOnlyWallet(["solana:devnet"]),
      connection: rpc({
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 200, // past lastValidBlockHeight
      }),
      pollLimit: 3,
    });
    expect(r).toMatchObject({ phase: "failed", reason: "expired" });
  });

  it("flags wrong-cluster when the wallet broadcast a signature that never lands here", async () => {
    const wallet: SigningWallet = {
      address: payer.publicKey.toBase58(),
      chains: undefined, // no chains advertised → preflight can't catch it
      signAndSend: async () => "sigNeverLands",
    };
    const r = await sendTransaction({
      ...base,
      wallet,
      preferWalletBroadcast: true,
      connection: rpc({
        getSignatureStatuses: async () => ({ value: [null] }),
        getBlockHeight: async () => 200,
      }),
      pollLimit: 3,
    });
    expect(r).toMatchObject({ phase: "failed", reason: "wrong-cluster" });
  });
});
