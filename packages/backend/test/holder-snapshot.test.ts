/**
 * Holder-snapshot service — spec 6.8 `distribute`: "backend snapshots
 * holders at slot (RPC/DAS), builds tree". Written before implementation.
 *
 * Two sources behind one seam:
 *  - RpcHolderSnapshot: getProgramAccounts on the token program, memcmp on
 *    the mint at offset 0, 72-byte data slice (mint|owner|amount) so the
 *    response stays small even for Token-2022 accounts with extensions;
 *    withContext pins the SLOT the snapshot was taken at.
 *  - DasHolderSnapshot: Helius DAS getTokenAccounts with cursor pagination
 *    (optional, feature-flagged per the env spec; degrades gracefully).
 *
 * POST /snapshots turns a snapshot + totalLamports into the ClaimShare[]
 * a distribute proposal is built from, excluding the DAO's own accounts.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { createApiHandler, type ApiDeps } from "../src/http-api";
import { MemoryLaunchStore } from "../src/launch-machine";
import { MemoryArtifactStore } from "../src/artifacts";
import {
  DasHolderSnapshot,
  RpcHolderSnapshot,
  makeHolderSnapshotSource,
  type HolderSnapshotSource,
} from "../src/holder-snapshot";

const mint = Keypair.generate().publicKey;

/** 72-byte token-account slice: mint | owner | amount (u64 LE). */
function slice(owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(72);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

describe("RpcHolderSnapshot", () => {
  it("queries the token program by mint with a 72-byte slice and returns slot + holders", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    let seen: { programId: PublicKey; config: Record<string, unknown> } | null =
      null;
    const connection = {
      async getProgramAccounts(
        programId: PublicKey,
        config: Record<string, unknown>,
      ) {
        seen = { programId, config };
        return {
          context: { slot: 123_456 },
          value: [
            { pubkey: Keypair.generate().publicKey, account: { data: slice(a, 300n) } },
            { pubkey: Keypair.generate().publicKey, account: { data: slice(b, 200n) } },
          ],
        };
      },
    } as unknown as Connection;

    const source = new RpcHolderSnapshot(connection);
    const snap = await source.snapshotHolders(mint);

    expect(seen!.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    expect(seen!.config["withContext"]).toBe(true);
    expect(seen!.config["dataSlice"]).toEqual({ offset: 0, length: 72 });
    expect(seen!.config["filters"]).toEqual([
      { memcmp: { offset: 0, bytes: mint.toBase58() } },
    ]);
    expect(snap.slot).toBe(123_456);
    expect(snap.holders).toHaveLength(2);
    expect(snap.holders[0]!.owner.equals(a)).toBe(true);
    expect(snap.holders[0]!.amount).toBe(300n);
    expect(snap.holders[1]!.amount).toBe(200n);
  });

  it("rejects short slices instead of mis-parsing (a fund-path input)", async () => {
    const connection = {
      async getProgramAccounts() {
        return {
          context: { slot: 1 },
          value: [{ pubkey: PublicKey.default, account: { data: Buffer.alloc(64) } }],
        };
      },
    } as unknown as Connection;
    await expect(
      new RpcHolderSnapshot(connection).snapshotHolders(mint),
    ).rejects.toThrow(/slice/i);
  });

  // The PUBLIC mainnet RPC excludes the token programs from secondary
  // indexes (verified live, D-026): gPA fails with -32010. The env spec
  // promises zero-signup defaults work, so the source falls back to
  // getTokenLargestAccounts + owner reads — exact for <= 19 accounts.
  function fallbackConnection(pairs: { owner: PublicKey; amount: bigint }[]) {
    const addresses = pairs.map(() => Keypair.generate().publicKey);
    return {
      async getProgramAccounts() {
        throw new Error(
          "failed to get accounts owned by program Tokenz...: excluded from account secondary indexes; this RPC method unavailable for key",
        );
      },
      async getTokenLargestAccounts(m: PublicKey) {
        expect(m.equals(mint)).toBe(true);
        return {
          context: { slot: 777 },
          value: pairs.map((p, i) => ({
            address: addresses[i]!,
            amount: p.amount.toString(),
          })),
        };
      },
      async getMultipleAccountsInfo(addrs: PublicKey[]) {
        return addrs.map((addr) => {
          const i = addresses.findIndex((a) => a.equals(addr));
          return { data: slice(pairs[i]!.owner, pairs[i]!.amount) };
        });
      },
    } as unknown as Connection;
  }

  it("falls back to getTokenLargestAccounts when gPA is index-excluded", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const source = new RpcHolderSnapshot(
      fallbackConnection([
        { owner: a, amount: 300n },
        { owner: b, amount: 200n },
      ]),
    );
    const snap = await source.snapshotHolders(mint);
    expect(snap.slot).toBe(777);
    expect(snap.holders).toHaveLength(2);
    expect(snap.holders[0]!.owner.equals(a)).toBe(true);
    expect(snap.holders[0]!.amount).toBe(300n);
  });

  it("the fallback REFUSES a possibly-truncated top-20 result (fund-path input)", async () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      owner: Keypair.generate().publicKey,
      amount: BigInt(i + 1),
    }));
    await expect(
      new RpcHolderSnapshot(fallbackConnection(pairs)).snapshotHolders(mint),
    ).rejects.toThrow(/truncat/i);
  });
});

describe("DasHolderSnapshot", () => {
  function dasFetch(pages: Record<string, unknown>[]): typeof fetch {
    let call = 0;
    return (async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: { cursor?: string };
      };
      if (body.method === "getSlot") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: 999 }));
      }
      expect(body.method).toBe("getTokenAccounts");
      const page = pages[call++]!;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result: page }));
    }) as unknown as typeof fetch;
  }

  it("paginates with cursors and aggregates pages; slot from the same endpoint", async () => {
    const a = Keypair.generate().publicKey;
    const b = Keypair.generate().publicKey;
    const source = new DasHolderSnapshot({
      url: "https://example.invalid/?api-key=x",
      fetchImpl: dasFetch([
        {
          token_accounts: [
            { owner: a.toBase58(), amount: 100, frozen: false },
          ],
          cursor: "next-1",
        },
        {
          token_accounts: [{ owner: b.toBase58(), amount: "200" }],
        },
      ]),
    });
    const snap = await source.snapshotHolders(mint);
    expect(snap.slot).toBe(999);
    expect(snap.holders).toHaveLength(2);
    expect(snap.holders[0]!.owner.equals(a)).toBe(true);
    expect(snap.holders[0]!.amount).toBe(100n);
    expect(snap.holders[1]!.amount).toBe(200n);
  });

  it("refuses unsafe JSON-number amounts instead of losing precision (INV-6)", async () => {
    const source = new DasHolderSnapshot({
      url: "https://example.invalid/?api-key=x",
      fetchImpl: dasFetch([
        {
          token_accounts: [
            { owner: Keypair.generate().publicKey.toBase58(), amount: 2 ** 53 },
          ],
        },
      ]),
    });
    await expect(source.snapshotHolders(mint)).rejects.toThrow(/safe integer/i);
  });
});

describe("makeHolderSnapshotSource", () => {
  it("prefers DAS when a Helius URL is configured, else RPC (graceful degrade)", () => {
    const connection = {} as Connection;
    expect(
      makeHolderSnapshotSource({ connection, heliusUrl: "https://h/?api-key=x" }),
    ).toBeInstanceOf(DasHolderSnapshot);
    expect(makeHolderSnapshotSource({ connection })).toBeInstanceOf(
      RpcHolderSnapshot,
    );
  });
});

// ---------- POST /snapshots route ----------

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function startApi(snapshot?: HolderSnapshotSource) {
  const deps: ApiDeps = {
    launchStore: new MemoryLaunchStore(),
    artifactStore: new MemoryArtifactStore(),
    buildSteps: () => [],
    snapshot,
  };
  server = createServer(createApiHandler(deps));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe("POST /snapshots", () => {
  const vault = Keypair.generate().publicKey;
  const holderA = Keypair.generate().publicKey;
  const holderB = Keypair.generate().publicKey;

  const fakeSource: HolderSnapshotSource = {
    async snapshotHolders(m: PublicKey) {
      expect(m.equals(mint)).toBe(true);
      return {
        slot: 42,
        holders: [
          { owner: vault, amount: 700n }, // excluded below
          { owner: holderA, amount: 200n },
          { owner: holderB, amount: 100n },
        ],
      };
    },
  };

  it("returns slot-pinned pro-rata shares with the DAO's accounts excluded", async () => {
    const base = await startApi(fakeSource);
    const res = await fetch(`${base}/snapshots`, {
      method: "POST",
      body: JSON.stringify({
        mint: mint.toBase58(),
        totalLamports: "900",
        excludeOwners: [vault.toBase58()],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slot: number;
      heldSupply: string;
      allocatedLamports: string;
      dustLamports: string;
      shares: { claimant: string; lamports: string }[];
    };
    expect(body.slot).toBe(42);
    expect(body.heldSupply).toBe("300");
    expect(body.allocatedLamports).toBe("900");
    expect(body.dustLamports).toBe("0");
    expect(body.shares).toHaveLength(2);
    const byClaimant = new Map(body.shares.map((s) => [s.claimant, s.lamports]));
    expect(byClaimant.get(holderA.toBase58())).toBe("600");
    expect(byClaimant.get(holderB.toBase58())).toBe("300");
  });

  it("validates inputs: bad mint / non-positive total are 400", async () => {
    const base = await startApi(fakeSource);
    const post = (body: unknown) =>
      fetch(`${base}/snapshots`, { method: "POST", body: JSON.stringify(body) });
    expect((await post({ mint: "nope", totalLamports: "1" })).status).toBe(400);
    expect(
      (await post({ mint: mint.toBase58(), totalLamports: "0" })).status,
    ).toBe(400);
    expect((await post({ mint: mint.toBase58() })).status).toBe(400);
  });

  it("is 501 when no snapshot source is configured", async () => {
    const base = await startApi();
    const res = await fetch(`${base}/snapshots`, {
      method: "POST",
      body: JSON.stringify({ mint: mint.toBase58(), totalLamports: "1" }),
    });
    expect(res.status).toBe(501);
  });
});
