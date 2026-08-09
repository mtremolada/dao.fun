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
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  CPMM_AMM_CONFIG_LEN,
  CPMM_POOL_STATE_LEN,
  EVENT_IX_TAG,
  configPda,
  curvePda,
  eventDiscriminator,
  metadataPda,
} from "@daofun/sdk/launchpad";
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

/**
 * BondingCurve account bytes, matching `decodeCurve`'s offsets AND the
 * deployed account's SIZE — the trailing bump byte makes it 143, which the
 * profile's getProgramAccounts dataSize filter depends on.
 */
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
    Buffer.from([255]), // bump
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

/** SPL token account bytes (mint, owner, amount at 64) — enough for the readers. */
export function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d.writeUInt32LE(1, 108); // state: initialized
  return d;
}

/** Devnet CPMM program id — only its role as the pool account's OWNER matters. */
export const CPMM_PROGRAM = new PublicKey("CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW");

/**
 * The four accounts behind a graduated coin's Raydium pool — PoolState (at
 * the packed offsets `decodeCpmmPool` reads), AmmConfig (0.25% fee), and the
 * two vaults, byte-sort ordered exactly like the real pool.
 */
export function poolAccounts(
  mint: PublicKey,
  poolState: PublicKey,
  reserves: { wsol: bigint; coin: bigint },
): Map<string, StubAccount> {
  const wsolIsToken0 = Buffer.compare(NATIVE_MINT.toBuffer(), mint.toBuffer()) < 0;
  const [mint0, mint1] = wsolIsToken0 ? [NATIVE_MINT, mint] : [mint, NATIVE_MINT];
  const [amount0, amount1] = wsolIsToken0
    ? [reserves.wsol, reserves.coin]
    : [reserves.coin, reserves.wsol];
  const seeded = (label: string) =>
    new PublicKey(Buffer.from(label.padEnd(32, "\0")).subarray(0, 32));
  const ammConfig = seeded("e2e-amm-config");
  const vault0 = seeded("e2e-vault0");
  const vault1 = seeded("e2e-vault1");
  const authority = seeded("e2e-authority");

  const pool = Buffer.alloc(CPMM_POOL_STATE_LEN);
  ammConfig.toBuffer().copy(pool, 8);
  vault0.toBuffer().copy(pool, 72);
  vault1.toBuffer().copy(pool, 104);
  mint0.toBuffer().copy(pool, 168);
  mint1.toBuffer().copy(pool, 200);
  TOKEN_PROGRAM_ID.toBuffer().copy(pool, 232);
  TOKEN_PROGRAM_ID.toBuffer().copy(pool, 264);
  seeded("e2e-observation").toBuffer().copy(pool, 296);
  pool[331] = wsolIsToken0 ? 9 : 6;
  pool[332] = wsolIsToken0 ? 6 : 9;
  // status, fees, open_time stay zero: pool open, nothing accrued.

  const cfg = Buffer.alloc(CPMM_AMM_CONFIG_LEN);
  cfg.writeBigUInt64LE(2500n, 12); // trade_fee_rate 0.25%

  return new Map<string, StubAccount>([
    [poolState.toBase58(), { data: pool, owner: CPMM_PROGRAM }],
    [ammConfig.toBase58(), { data: cfg, owner: CPMM_PROGRAM }],
    [vault0.toBase58(), { data: tokenAccountData(mint0, authority, amount0), owner: TOKEN_PROGRAM_ID }],
    [vault1.toBase58(), { data: tokenAccountData(mint1, authority, amount1), owner: TOKEN_PROGRAM_ID }],
  ]);
}

export interface StubTrade {
  signature: string;
  slot: number;
  blockTime: number;
  trader: PublicKey;
  isBuy: boolean;
  tokenAmount: bigint;
  solAmount: bigint;
  virtualSol: bigint;
  virtualToken: bigint;
}

/**
 * A confirmed transaction carrying one TradeEvent as a self-CPI inner
 * instruction — the exact wire shape `fetchTradeHistory` decodes.
 */
export function tradeTransactionJson(mint: PublicKey, t: StubTrade): unknown {
  const body = Buffer.concat([
    EVENT_IX_TAG,
    eventDiscriminator("TradeEvent"),
    mint.toBuffer(),
    t.trader.toBuffer(),
    Buffer.from([t.isBuy ? 1 : 0]),
    u64(t.tokenAmount),
    u64(t.solAmount),
    u64(0n), // protocolFee
    u64(0n), // creatorFee
    u64(t.virtualSol),
    u64(t.virtualToken),
    u64(0n), // realSol
    u64(0n), // realToken
  ]);
  return {
    slot: t.slot,
    blockTime: t.blockTime,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      innerInstructions: [
        {
          index: 0,
          instructions: [{ programIdIndex: 2, accounts: [], data: bs58.encode(body) }],
        },
      ],
      logMessages: [],
    },
    transaction: {
      signatures: [t.signature],
      message: {
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 2,
        },
        accountKeys: [
          t.trader.toBase58(),
          curvePda(mint, PROGRAM_ID).toBase58(),
          PROGRAM_ID.toBase58(),
        ],
        recentBlockhash: BLOCKHASH,
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: "" }],
      },
    },
  };
}

export interface RpcStubOptions {
  /**
   * Called for every sendTransaction with the wire bytes; `register` adds
   * accounts to the stubbed chain (how a create-coin test materializes the
   * curve + metadata for the mint the browser just generated).
   */
  onSendTransaction?: (tx: Transaction, register: (address: string, acc: StubAccount) => void) => void;
  /** Trade history served for getSignaturesForAddress/getTransaction, newest first. */
  trades?: { mint: PublicKey; list: StubTrade[] };
  /** Lamport balances by address; anything unlisted falls back to 5 SOL. */
  balances?: Map<string, number>;
}

/**
 * Intercept `/__rpc` and answer from the fabricated account map. Handles
 * both single requests and JSON-RPC batches (web3's getTransactions posts
 * one array-bodied batch).
 */
export async function installRpcStub(
  page: Page,
  accounts: Map<string, StubAccount>,
  opts: RpcStubOptions = {},
): Promise<void> {
  const accountJson = (acc: StubAccount | undefined) => ({
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

  const handle = (req: { method: string; params?: unknown[] }): unknown => {
    switch (req.method) {
      case "getAccountInfo":
        return accountJson(accounts.get(req.params?.[0] as string));
      case "getMultipleAccounts": {
        const keys = (req.params?.[0] as string[]) ?? [];
        return {
          context: { apiVersion: "1.18.0", slot: 1 },
          value: keys.map((k) => accountJson(accounts.get(k)).value),
        };
      }
      case "getBalance": {
        const addr = req.params?.[0] as string;
        return {
          context: { slot: 1 },
          value: opts.balances?.get(addr) ?? 5_000_000_000,
        };
      }
      case "getMinimumBalanceForRentExemption":
        return 890_880;
      case "getProgramAccounts": {
        // Answer from the same fabricated account map, applying the caller's
        // dataSize + memcmp filters exactly as a validator would — so a spec
        // proves the FILTERS, not just the happy path.
        // web3 sends [programId, { commitment, encoding, filters, ... }] —
        // the filters live INSIDE the config object, not as params[1].
        const cfg = req.params?.[1] as
          | { filters?: { dataSize?: number; memcmp?: { offset: number; bytes: string } }[] }
          | undefined;
        const filters = cfg?.filters ?? [];
        const owner = req.params?.[0] as string;
        const out: unknown[] = [];
        for (const [address, acc] of accounts) {
          if (acc.owner.toBase58() !== owner) continue;
          const ok = filters.every((f) => {
            if (f.dataSize !== undefined) return acc.data.length === f.dataSize;
            if (f.memcmp) {
              const want = new PublicKey(f.memcmp.bytes).toBuffer();
              return acc.data.subarray(f.memcmp.offset, f.memcmp.offset + want.length).equals(want);
            }
            return true;
          });
          if (!ok) continue;
          out.push({
            pubkey: address,
            account: {
              data: [acc.data.toString("base64"), "base64"],
              executable: false,
              lamports: 2_039_280,
              owner: acc.owner.toBase58(),
              rentEpoch: 0,
              space: acc.data.length,
            },
          });
        }
        return out;
      }
      case "getSignaturesForAddress": {
        const address = req.params?.[0] as string;
        const t = opts.trades;
        if (!t || curvePda(t.mint, PROGRAM_ID).toBase58() !== address) return [];
        return t.list.map((x) => ({
          signature: x.signature,
          slot: x.slot,
          err: null,
          memo: null,
          blockTime: x.blockTime,
          confirmationStatus: "confirmed",
        }));
      }
      case "getTransaction": {
        const sig = req.params?.[0] as string;
        const t = opts.trades;
        const found = t?.list.find((x) => x.signature === sig);
        return found ? tradeTransactionJson(t!.mint, found) : null;
      }
      case "getLatestBlockhash":
        return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 } };
      case "getBlockHeight":
        return 10;
      case "simulateTransaction":
        return {
          context: { slot: 1 },
          value: { err: null, logs: [], accounts: null, unitsConsumed: 80_000, returnData: null },
        };
      case "sendTransaction": {
        const raw = Buffer.from(req.params?.[0] as string, "base64");
        opts.onSendTransaction?.(Transaction.from(raw), (address, acc) => accounts.set(address, acc));
        return FAKE_SIG;
      }
      case "getSignatureStatuses":
        return {
          context: { slot: 1 },
          value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
        };
      case "getVersion":
        return { "solana-core": "1.18.0", "feature-set": 1 };
      default:
        return null;
    }
  };

  await page.route("**/__rpc", async (route) => {
    if (process.env.E2E_RPC_LOG) {
      const p = JSON.parse(route.request().postData() ?? "{}");
      for (const r of Array.isArray(p) ? p : [p]) console.log("[rpc]", r.method);
    }
    const parsed = JSON.parse(route.request().postData() ?? "{}") as
      | { id: number; method: string; params?: unknown[] }
      | { id: number; method: string; params?: unknown[] }[];
    const body = Array.isArray(parsed)
      ? parsed.map((r) => ({ jsonrpc: "2.0", id: r.id, result: handle(r) }))
      : { jsonrpc: "2.0", id: parsed.id, result: handle(parsed) };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
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

/**
 * Register a fake INJECTED provider (window.phantom.solana) — the path
 * Phantom actually uses and the wallet-standard fake does NOT exercise.
 * It signs by echoing the transaction bytes back, like the standard fake.
 */
export async function installInjectedWallet(page: Page): Promise<void> {
  await page.addInitScript(({ address }) => {
    const provider = {
      isPhantom: true,
      publicKey: { toString: () => address },
      connect: async () => ({ publicKey: { toString: () => address } }),
      disconnect: async () => {},
      // Legacy injected API: takes and returns a Transaction-like object.
      signTransaction: async (tx: { serialize: (o?: unknown) => Uint8Array }) => ({
        serialize: () => tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
      }),
    };
    (window as unknown as Record<string, unknown>)["phantom"] = { solana: provider };
    (window as unknown as Record<string, unknown>)["solana"] = provider;
  }, { address: WALLET_ADDRESS });
}

/** Connect the fake wallet through the real top-right modal. */
export async function connectWallet(page: Page): Promise<void> {
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-solflare").click();
}
