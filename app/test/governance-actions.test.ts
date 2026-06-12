/**
 * Browser-signing flow (D-028) — written before the component wiring.
 * The flow is build -> sign -> submit with injected fetch + signer; the
 * wallet-standard adapter moves raw bytes <-> base64. No chain deps.
 */
import { describe, expect, it } from "vitest";
import { castVoteFlow, depositFlow, type FlowState } from "../lib/governance-actions";
import {
  base64ToBytes,
  bytesToBase64,
  connectWallet,
  discoverWallets,
  makeSigner,
  type StandardWalletLike,
} from "../lib/wallet-standard";

const WALLET = "BrowserHo1der1111111111111111111111111111111";

function fakeFetch(
  routes: Record<string, { status: number; body: unknown } | ((body: unknown) => { status: number; body: unknown })>,
  calls: { url: string; body: unknown }[],
): typeof fetch {
  return (async (url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    const route = routes[String(url)];
    if (!route) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    const r = typeof route === "function" ? route(body) : route;
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

const signer = {
  address: WALLET,
  async signTransaction(txBase64: string) {
    return `signed:${txBase64}`;
  },
};

describe("castVoteFlow", () => {
  it("build -> sign -> submit; phases in order; payloads exact", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const phases: string[] = [];
    const result = await castVoteFlow(
      { proposal: "Prop111", approve: true },
      {
        signer,
        fetchImpl: fakeFetch(
          {
            "/api/chain/txs/cast-vote": { status: 200, body: { txBase64: "dW5zaWduZWQ=" } },
            "/api/chain/txs/submit": (body) => {
              expect(body).toEqual({ signedTxBase64: "signed:dW5zaWduZWQ=" });
              return { status: 200, body: { signature: "SIG42" } };
            },
          },
          calls,
        ),
        onState: (s: FlowState) => phases.push(s.phase),
      },
    );
    expect(result).toEqual({ phase: "done", signature: "SIG42" });
    expect(phases).toEqual(["building", "signing", "submitting", "done"]);
    expect(calls[0]!.body).toEqual({
      proposal: "Prop111",
      wallet: WALLET,
      approve: true,
    });
  });

  it("API build errors surface as error state with the server message", async () => {
    const result = await castVoteFlow(
      { proposal: "P", approve: false },
      {
        signer,
        fetchImpl: fakeFetch(
          { "/api/chain/txs/cast-vote": { status: 400, body: { error: "bad proposal" } } },
          [],
        ),
      },
    );
    expect(result.phase).toBe("error");
    expect(result.error).toBe("bad proposal");
  });

  it("a wallet rejection surfaces as error, nothing is submitted", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const result = await castVoteFlow(
      { proposal: "P", approve: true },
      {
        signer: {
          address: WALLET,
          async signTransaction() {
            throw new Error("user rejected");
          },
        },
        fetchImpl: fakeFetch(
          { "/api/chain/txs/cast-vote": { status: 200, body: { txBase64: "AA==" } } },
          calls,
        ),
      },
    );
    expect(result).toEqual({ phase: "error", error: "user rejected" });
    expect(calls.map((c) => c.url)).toEqual(["/api/chain/txs/cast-vote"]);
  });
});

describe("depositFlow", () => {
  it("posts the deposit request with the signer's wallet", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const result = await depositFlow(
      { realm: "R", governingTokenMint: "M", amount: "5000" },
      {
        signer,
        fetchImpl: fakeFetch(
          {
            "/api/chain/txs/deposit": {
              status: 200,
              body: { txBase64: "AA==", tokenOwnerRecord: "tor" },
            },
            "/api/chain/txs/submit": { status: 200, body: { signature: "S" } },
          },
          calls,
        ),
      },
    );
    expect(result.phase).toBe("done");
    expect(calls[0]!.body).toEqual({
      realm: "R",
      governingTokenMint: "M",
      wallet: WALLET,
      amount: "5000",
    });
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
