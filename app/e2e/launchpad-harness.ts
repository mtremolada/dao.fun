/**
 * Shared harness for the launchpad e2e specs (board / coin / create).
 *
 * Hermetic by construction: the app's RPC is pointed at a same-origin path
 * (`/__rpc`) that Playwright intercepts before it hits the network, and the
 * handler speaks just enough JSON-RPC for the read path (getAccountInfo) and
 * the full send pipeline (blockhash → simulate → send → signature status).
 * Account bytes are fabricated with the SAME layouts the SDK decoders read,
 * so a struct change on chain surfaces here as a failing offset, not a
 * silently-green test.
 */
import type { Page } from "@playwright/test";
import { PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { configPda, curvePda, metadataPda } from "@daofun/sdk/launchpad";
import { launchpadProgramId } from "../lib/cluster";

// Same-origin so fulfilled responses need no CORS dance; next dev would 404
// this path, which is exactly why an un-stubbed request fails loudly.
export const RPC_URL = "http://127.0.0.1:3210/__rpc";

export const PROGRAM_ID = launchpadProgramId();
export const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const WALLET_ADDRESS = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
export const CREATOR = new PublicKey("FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds");
// Any 32-byte base58 string works as a blockhash for message compilation.
export const BLOCKHASH = "So11111111111111111111111111111111111111112";
export const FAKE_SIG = bs58.encode(Buffer.alloc(64, 7));

const u64 = (v: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
};
const u16 = (v: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const borshStr = (s: string) => {
  const d = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(d.length);
  return Buffer.concat([len, d]);
};

export interface CurveFields {
  mint: PublicKey;
  creator?: PublicKey;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  complete?: boolean;
  migrated?: boolean;
  poolState?: PublicKey;
}

/** BondingCurve account bytes, matching `decodeCurve`'s offsets. */
export function curveAccountData(c: CurveFields): Buffer {
  return Buffer.concat([
    Buffer.alloc(8), // discriminator — the decoder skips it
    c.mint.toBuffer(),
    (c.creator ?? CREATOR).toBuffer(),
    u64(c.virtualSol),
    u64(c.virtualToken),
    u64(c.realSol),
    u64(c.realToken),
    u16(70),
    u16(30),
    Buffer.from([c.complete ? 1 : 0, c.migrated ? 1 : 0]),
    (c.poolState ?? PublicKey.default).toBuffer(),
  ]);
}

/** Metaplex metadata bytes: key + updateAuthority + mint, then borsh strings. */
export function metadataAccountData(name: string, symbol: string, uri: string): Buffer {
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.alloc(32),
    Buffer.alloc(32),
    borshStr(name),
    borshStr(symbol),
    borshStr(uri),
  ]);
}

/** Config account bytes per `decodeConfig` — only feeRecipient matters to the app. */
export function configAccountData(feeRecipient: PublicKey): Buffer {
  return Buffer.concat([
    Buffer.alloc(8),
    Buffer.alloc(32), // authority
    feeRecipient.toBuffer(),
    u16(70),
    u16(30),
    u64(150_000_000n), // graduation fee
    u64(30_000_000_000n),
    u64(1_073_000_000_000_000n),
    u64(793_100_000_000_000n),
    u64(1_000_000_000_000_000n),
    Buffer.alloc(32 * 3), // cpmm program / amm config / create-pool fee
  ]);
}

/**
 * A mid-curve coin: 400e12 of the 793.1e12 sellable reserve sold (~50%),
 * reserves kept consistent with the pump-classic invariant so client-side
 * quoting produces sane numbers.
 */
export function midCurve(mint: PublicKey): CurveFields {
  return {
    mint,
    virtualSol: 47_830_609_212n,
    virtualToken: 673_000_000_000_000n,
    realSol: 17_830_609_212n,
    realToken: 393_100_000_000_000n,
  };
}

export interface StubAccount {
  data: Buffer;
  owner: PublicKey;
}

/** The three accounts behind one coin, keyed by their on-chain address. */
export function coinAccounts(
  mint: PublicKey,
  curve: CurveFields,
  meta: { name: string; symbol: string; uri?: string },
): Map<string, StubAccount> {
  return new Map<string, StubAccount>([
    [
      curvePda(mint, PROGRAM_ID).toBase58(),
      { data: curveAccountData(curve), owner: PROGRAM_ID },
    ],
    [
      metadataPda(mint, METAPLEX).toBase58(),
      {
        data: metadataAccountData(meta.name, meta.symbol, meta.uri ?? "https://example.invalid/meta.json"),
        owner: METAPLEX,
      },
    ],
    [
      configPda(PROGRAM_ID).toBase58(),
      { data: configAccountData(CREATOR), owner: PROGRAM_ID },
    ],
  ]);
}

export interface RpcStubOptions {
  /**
   * Called for every sendTransaction with the wire bytes; `register` adds
   * accounts to the stubbed chain (how a create-coin test materializes the
   * curve + metadata for the mint the browser just generated).
   */
  onSendTransaction?: (tx: Transaction, register: (address: string, acc: StubAccount) => void) => void;
}

/** Intercept `/__rpc` and answer from the fabricated account map. */
export async function installRpcStub(
  page: Page,
  accounts: Map<string, StubAccount>,
  opts: RpcStubOptions = {},
): Promise<void> {
  await page.route("**/__rpc", async (route) => {
    const req = JSON.parse(route.request().postData() ?? "{}") as {
      id: number;
      method: string;
      params?: unknown[];
    };
    const respond = (result: unknown) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ jsonrpc: "2.0", id: req.id, result }),
      });

    switch (req.method) {
      case "getAccountInfo": {
        const acc = accounts.get(req.params?.[0] as string);
        return respond({
          context: { apiVersion: "1.18.0", slot: 1 },
          value: acc
            ? {
                data: [acc.data.toString("base64"), "base64"],
                executable: false,
                lamports: 2_039_280,
                owner: acc.owner.toBase58(),
                rentEpoch: 0,
                space: acc.data.length,
              }
            : null,
        });
      }
      case "getLatestBlockhash":
        return respond({ context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } });
      case "getBlockHeight":
        return respond(10);
      case "simulateTransaction":
        return respond({
          context: { slot: 1 },
          value: { err: null, logs: [], accounts: null, unitsConsumed: 80_000, returnData: null },
        });
      case "sendTransaction": {
        const raw = Buffer.from(req.params?.[0] as string, "base64");
        opts.onSendTransaction?.(Transaction.from(raw), (address, acc) => accounts.set(address, acc));
        return respond(FAKE_SIG);
      }
      case "getSignatureStatuses":
        return respond({
          context: { slot: 1 },
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
        });
      case "getVersion":
        return respond({ "solana-core": "1.18.0", "feature-set": 1 });
      default:
        return respond(null);
    }
  });
}

/** Seed localStorage before any app script runs (RPC override + local board). */
export async function seedBrowser(page: Page, opts: { coins?: string[] } = {}): Promise<void> {
  await page.addInitScript(
    ({ rpc, coins }) => {
      try {
        localStorage.setItem("daofun:rpc", rpc);
        if (coins) localStorage.setItem("daofun:local-coins", JSON.stringify(coins));
      } catch {
        /* private mode */
      }
    },
    { rpc: RPC_URL, coins: opts.coins ?? null },
  );
}

/**
 * Register a fake wallet-standard wallet BEFORE load — the same registration
 * handshake real wallets use. Exposes the sign-only feature (the deterministic
 * devnet path): it echoes the transaction bytes back, and the harness RPC
 * accepts them, so the pipeline runs end to end without a key.
 */
export async function installFakeWallet(
  page: Page,
  opts: { chains?: string[] } = {},
): Promise<void> {
  await page.addInitScript(
    ({ address, chains }) => {
      const account = { address, chains };
      const wallet = {
        version: "1.0.0",
        name: "Solflare",
        icon: "data:image/svg+xml;base64,",
        chains,
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async (input: { silent?: boolean }) => {
              void input.silent;
              return { accounts: [account] };
            },
          },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signTransaction": {
            version: "1.0.0",
            signTransaction: async (input: { transaction: Uint8Array }) => [
              { signedTransaction: input.transaction },
            ],
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", ((
        event: CustomEvent<{ register: (...ws: unknown[]) => void }>,
      ) => {
        event.detail.register(wallet);
      }) as EventListener);
    },
    { address: WALLET_ADDRESS, chains: opts.chains ?? ["solana:devnet"] },
  );
}

/** Connect the fake wallet through the real top-right modal. */
export async function connectWallet(page: Page): Promise<void> {
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-solflare").click();
}
