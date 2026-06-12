/**
 * Client-side governance flow (decentralized): build -> sign -> submit ->
 * confirm, hitting the RPC directly. The flow machine is tested with a fake
 * Connection + injected build; the resolvers/builders are proven on the real
 * binaries (wallet-vote + F-7 integration suites, via the SDK).
 */
import { describe, expect, it } from "vitest";
import type { Connection } from "@solana/web3.js";
import { runClientFlow } from "../lib/governance-client";
import type { FlowState } from "../lib/governance-actions";

// A real wallet returns valid base64 signed bytes; mimic that with a marker.
const SIGNED_B64 = Buffer.from("SIGNED-PAYLOAD").toString("base64");
const signer = {
  address: "BrowserHo1der1111111111111111111111111111111",
  async signTransaction(_txBase64: string) {
    return SIGNED_B64;
  },
};

function fakeConnection(
  sent: string[],
  opts: { failConfirm?: boolean } = {},
): Connection {
  return {
    async sendRawTransaction(bytes: Uint8Array) {
      sent.push(Buffer.from(bytes).toString());
      return "SIG-CLIENT";
    },
    async confirmTransaction() {
      if (opts.failConfirm) throw new Error("blockhash expired");
      return { value: { err: null } };
    },
  } as unknown as Connection;
}

describe("runClientFlow (no backend in the path)", () => {
  it("build -> sign -> submit -> confirm; phases in order; signed bytes hit the RPC", async () => {
    const sent: string[] = [];
    const phases: string[] = [];
    const result = await runClientFlow(async () => "dW5zaWduZWQ=", {
      signer,
      connection: fakeConnection(sent),
      onState: (s: FlowState) => phases.push(s.phase),
    });
    expect(result).toEqual({ phase: "done", signature: "SIG-CLIENT" });
    expect(phases).toEqual(["building", "signing", "submitting", "done"]);
    // the wallet-signed payload (not the unsigned one) was submitted to chain
    expect(sent).toEqual(["SIGNED-PAYLOAD"]);
  });

  it("a build/resolve error surfaces as error state, nothing submitted", async () => {
    const sent: string[] = [];
    const result = await runClientFlow(
      async () => {
        throw new Error("proposal not found");
      },
      { signer, connection: fakeConnection(sent) },
    );
    expect(result.phase).toBe("error");
    expect(result.error).toBe("proposal not found");
    expect(sent).toEqual([]);
  });

  it("a wallet rejection surfaces as error before submit", async () => {
    const sent: string[] = [];
    const result = await runClientFlow(async () => "AA==", {
      signer: {
        address: signer.address,
        async signTransaction() {
          throw new Error("user rejected");
        },
      },
      connection: fakeConnection(sent),
    });
    expect(result).toEqual({ phase: "error", error: "user rejected" });
    expect(sent).toEqual([]);
  });
});
