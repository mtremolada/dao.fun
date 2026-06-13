/**
 * Client-side governance flow (serverless): build (in-browser) -> sign+send
 * (wallet). The builder and the wallet sender are injected so the state
 * machine is verified offline, with no RPC and no wallet extension.
 */
import { describe, expect, it } from "vitest";
import type { Connection, Transaction } from "@solana/web3.js";
import {
  castVoteFlow,
  depositFlow,
  type FlowState,
} from "../lib/governance-actions";
import type { WalletSender } from "../lib/wallet-sender";

// valid base58 pubkeys so PublicKey() parsing succeeds
const WALLET = "So11111111111111111111111111111111111111112";
const PROPOSAL = "11111111111111111111111111111111";
const REALM = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const fakeTx = { marker: "TX" } as unknown as Transaction;
const conn = {} as unknown as Connection;

function sender(
  signAndSend: WalletSender["signAndSend"],
): WalletSender {
  return { address: WALLET, signAndSend };
}

describe("castVoteFlow", () => {
  it("build -> send -> done; phases in order; the built tx is what gets sent", async () => {
    const phases: string[] = [];
    let sent: Transaction | null = null;
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: true },
      {
        connection: conn,
        sender: sender(async (tx) => {
          sent = tx;
          return "SIG42";
        }),
        buildTx: async () => fakeTx,
        onState: (s: FlowState) => phases.push(s.phase),
      },
    );
    expect(result).toEqual({ phase: "done", signature: "SIG42" });
    expect(phases).toEqual(["building", "sending", "done"]);
    expect(sent).toBe(fakeTx);
  });

  it("a build failure surfaces as error; nothing is sent", async () => {
    let sendCalls = 0;
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: false },
      {
        connection: conn,
        sender: sender(async () => {
          sendCalls++;
          return "nope";
        }),
        buildTx: async () => {
          throw new Error("rpc down");
        },
      },
    );
    expect(result.phase).toBe("error");
    expect(result.error).toBe("rpc down");
    expect(sendCalls).toBe(0);
  });

  it("a wallet rejection surfaces as error", async () => {
    const result = await castVoteFlow(
      { proposal: PROPOSAL, approve: true },
      {
        connection: conn,
        sender: sender(async () => {
          throw new Error("user rejected");
        }),
        buildTx: async () => fakeTx,
      },
    );
    expect(result).toEqual({ phase: "error", error: "user rejected" });
  });

  it("an invalid proposal address errors during build, never sends", async () => {
    let sendCalls = 0;
    const result = await castVoteFlow(
      { proposal: "not-a-pubkey", approve: true },
      {
        connection: conn,
        sender: sender(async () => {
          sendCalls++;
          return "nope";
        }),
      },
    );
    expect(result.phase).toBe("error");
    expect(result.error).toMatch(/invalid proposal/i);
    expect(sendCalls).toBe(0);
  });
});

describe("depositFlow", () => {
  it("builds then sends, returning the wallet signature", async () => {
    const result = await depositFlow(
      { realm: REALM, governingTokenMint: MINT, amount: "5000" },
      {
        connection: conn,
        sender: sender(async () => "DEPOSIT_SIG"),
        buildTx: async () => fakeTx,
      },
    );
    expect(result).toEqual({ phase: "done", signature: "DEPOSIT_SIG" });
  });
});
