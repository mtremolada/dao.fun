/**
 * Client launch — offline guards (D-033). The verifiable, network-free part of
 * the ceremony entry: it must refuse an invalid form and incomplete token
 * metadata BEFORE it ever touches the RPC or generates keypairs. (The on-chain
 * sequence itself reuses the real-binary-tested builders + step machine.)
 */
import { describe, expect, it } from "vitest";
import { Keypair, type Connection } from "@solana/web3.js";
import { runClientLaunch } from "../lib/client-launch";

const wallet = Keypair.generate().publicKey.toBase58();
const opts = {
  connection: {} as Connection, // never reached in these cases
  walletAddress: wallet,
  async signTransaction() {
    throw new Error("should not sign in a rejected launch");
  },
};
const goodMeta = { name: "Test", symbol: "TST", uri: "ipfs://meta.json" };

describe("runClientLaunch guards", () => {
  it("rejects an invalid form before any RPC/keypair work", async () => {
    await expect(
      runClientLaunch(
        // cypherpunk without the required confirmation
        { form: { mode: "cypherpunk", tier: "micro", confirmations: {} }, metadata: goodMeta },
        opts,
      ),
    ).rejects.toThrow(/confirmation/i);
  });

  it("rejects incomplete token metadata before any RPC/keypair work", async () => {
    await expect(
      runClientLaunch(
        {
          form: {
            mode: "cypherpunk",
            tier: "micro",
            confirmations: { noVetoIrreversible: true },
          },
          metadata: { name: "", symbol: "", uri: "" },
        },
        opts,
      ),
    ).rejects.toThrow(/name, symbol, and metadata uri/i);
  });
});
