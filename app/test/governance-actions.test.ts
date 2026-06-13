/**
 * Browser-signing flow (D-033): build -> sign -> submit over an injected
 * GovernanceTxSource (the SDK builds/submits client-side; no server). The
 * source is faked here so the state machine is exercised offline; the
 * wallet-standard adapter moves raw bytes <-> base64.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { GovernanceTxSource } from "@daofun/sdk/tx-builder";
import { castVoteFlow, depositFlow, type FlowState } from "../lib/governance-actions";
import {
  base64ToBytes,
  bytesToBase64,
  connectWallet,
  discoverWallets,
  makeSigner,
  type StandardWalletLike,
} from "../lib/wallet-standard";

const WALLET = Keypair.generate().publicKey.toBase58();
const PROPOSAL = Keypair.generate().publicKey.toBase58();
const REALM = Keypair.generate().publicKey.toBase58();
const MINT = Keypair.generate().publicKey.toBase58();

const signer = {
  address: WALLET,
  async signTransaction(txBase64: string) {
    return `signed:${txBase64}`;
  },
};

interface Call {
  method: "castVoteTx" | "depositTx" | "submit";
  arg: unknown;
}

function makeSource(behavior?: Partial<GovernanceTxSource>): {
  source: GovernanceTxSource;
  calls: Call[];
} {
  const calls: Call[] = [];
  const source: GovernanceTxSource = {
    async castVoteTx(req) {
      calls.push({ method: "castVoteTx", arg: req });
      return behavior?.castVoteTx
        ? behavior.castVoteTx(req)
        : { txBase64: "dW5zaWduZWQ=" };
    },
    async depositTx(req) {
      calls.push({ method: "depositTx", arg: req });
      return behavior?.depositTx
        ? behavior.depositTx(req)
        : { txBase64: "AA==", tokenOwnerRecord: "tor" };
    },
    async submit(signed) {
      calls.push({ method: "submit", arg: signed });
      return behavior?.submit ? behavior.submit(signed) : { signature: "SIG42" };
    },
  };
  return { source, calls };
}

describe("castVoteFlow", () => {
  it("build -> sign -> submit; phases in order; payloads exact", async () => {
    const { source, calls } = makeSource();
    const phases: string[] = [];
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: true },
      { signer, source, onState: (s: FlowState) => phases.push(s.phase) },
    );
    expect(result).toEqual({ phase: "done", signature: "SIG42" });
    expect(phases).toEqual(["building", "signing", "submitting", "done"]);

    const build = calls[0]!.arg as {
      proposal: { toBase58(): string };
      wallet: { toBase58(): string };
      approve: boolean;
    };
    expect(build.proposal.toBase58()).toBe(PROPOSAL);
    expect(build.wallet.toBase58()).toBe(WALLET);
    expect(build.approve).toBe(true);
    // submit received the wallet-signed bytes of the built tx
    expect(calls[1]).toEqual({ method: "submit", arg: "signed:dW5zaWduZWQ=" });
  });

  it("builder errors surface as error state with the message", async () => {
    const { source, calls } = makeSource({
      castVoteTx: async () => {
        throw new Error("bad proposal");
      },
    });
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: false },
      { signer, source },
    );
    expect(result.phase).toBe("error");
    expect(result.error).toBe("bad proposal");
    expect(calls.map((c) => c.method)).toEqual(["castVoteTx"]); // nothing submitted
  });

  it("a wallet rejection surfaces as error, nothing is submitted", async () => {
    const { source, calls } = makeSource();
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: true },
      {
        signer: {
          address: WALLET,
          async signTransaction() {
            throw new Error("user rejected");
          },
        },
        source,
      },
    );
    expect(result).toEqual({ phase: "error", error: "user rejected" });
    expect(calls.map((c) => c.method)).toEqual(["castVoteTx"]);
  });
});

describe("depositFlow", () => {
  it("builds the deposit with the signer's wallet and a bigint amount", async () => {
    const { source, calls } = makeSource();
    const result = await depositFlow(
      { realm: REALM, governingTokenMint: MINT, amount: "5000" },
      { signer, source },
    );
    expect(result.phase).toBe("done");
    const build = calls[0]!.arg as {
      realm: { toBase58(): string };
      governingTokenMint: { toBase58(): string };
      wallet: { toBase58(): string };
      amount: bigint;
    };
    expect(build.realm.toBase58()).toBe(REALM);
    expect(build.governingTokenMint.toBase58()).toBe(MINT);
    expect(build.wallet.toBase58()).toBe(WALLET);
    expect(build.amount).toBe(5000n);
  });
});

describe("wallet-standard adapter", () => {
  it("base64 helpers round-trip raw bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 7]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("discovers wallets registered via app-ready and connects + signs raw bytes", async () => {
    const account = { address: WALLET };
    const wallet: StandardWalletLike = {
      name: "FakeWallet",
      accounts: [],
      features: {
        "standard:connect": {
          connect: async () => ({ accounts: [account] }),
        },
        "solana:signTransaction": {
          signTransaction: async (input: { transaction: Uint8Array }) => [
            // "sign" = append a marker byte; proves raw bytes round-trip
            { signedTransaction: new Uint8Array([...input.transaction, 99]) },
          ],
        },
      },
    };
    // node has no window; an EventTarget carries the handshake exactly
    (globalThis as Record<string, unknown>)["window"] = new EventTarget();
    window.addEventListener("wallet-standard:app-ready", ((
      e: CustomEvent<{ register: (...ws: StandardWalletLike[]) => void }>,
    ) => {
      e.detail.register(wallet);
    }) as EventListener);

    const found = discoverWallets();
    expect(found.map((w) => w.name)).toContain("FakeWallet");
    const connected = await connectWallet(found[0]!);
    expect(connected.address).toBe(WALLET);
    const s = makeSigner(found[0]!, connected);
    const signed = await s.signTransaction(bytesToBase64(new Uint8Array([1, 2])));
    expect(base64ToBytes(signed)).toEqual(new Uint8Array([1, 2, 99]));
  });

  it("a wallet without the sign feature is refused at adapter construction", () => {
    expect(() =>
      makeSigner(
        { name: "ReadOnly", accounts: [], features: {} },
        { address: WALLET },
      ),
    ).toThrow(/cannot sign/);
  });
});
