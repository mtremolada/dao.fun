/**
 * /chain/* routes — written before implementation. The HTTP layer is
 * wiring only: a ChainReader is injected (RPC-backed in prod, fake here
 * and in the Playwright stub server), so these tests pin the route
 * contract the frontend consumes without touching the network.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApiHandler, type ApiDeps } from "../src/http-api";
import { MemoryLaunchStore } from "../src/launch-machine";
import { MemoryArtifactStore } from "../src/artifacts";
import type {
  ChainReader,
  DaoDashboard,
  ProposalChainState,
} from "../src/chain-reader";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

const knownProposal = Keypair.generate().publicKey;
const knownRealm = Keypair.generate().publicKey;
const vault = Keypair.generate().publicKey;

const proposalState: ProposalChainState = {
  proposal: knownProposal.toBase58(),
  name: "GATE1-p2: sweep vault via custody chain",
  state: "Completed",
  votingCompletedAt: 1_770_000_000,
  holdUpSeconds: 0,
  chainHash: "a".repeat(64),
  publishedArtifactHash: "a".repeat(64),
  vetoVoteWeight: "0",
  vetoed: false,
};

const dashboard: DaoDashboard = {
  realm: knownRealm.toBase58(),
  realmName: "dao-fun-realm",
  vault: vault.toBase58(),
  vaultBalanceLamports: 890_880,
  sweeps: [
    { signature: "sig-sweep-1", blockTime: 1_770_000_100, deltaLamports: 890_880 },
  ],
  votePower: { wallet: Keypair.generate().publicKey.toBase58(), depositedTokens: "200000000000" },
};

function fakeReader(): ChainReader {
  return {
    async getProposalState(proposal: PublicKey) {
      return proposal.equals(knownProposal) ? proposalState : null;
    },
    async getDashboard(realm: PublicKey) {
      return realm.equals(knownRealm) ? dashboard : null;
    },
  };
}

async function startApi(chain?: ChainReader) {
  const deps: ApiDeps = {
    launchStore: new MemoryLaunchStore(),
    artifactStore: new MemoryArtifactStore(),
    buildSteps: () => [],
    chain,
  };
  server = createServer(createApiHandler(deps));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

describe("GET /chain/proposals/:address", () => {
  it("serves the chain-derived proposal state", async () => {
    const base = await startApi(fakeReader());
    const res = await fetch(`${base}/chain/proposals/${knownProposal.toBase58()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(proposalState);
  });

  it("unknown proposal is 404, invalid pubkey is 400", async () => {
    const base = await startApi(fakeReader());
    const unknown = Keypair.generate().publicKey.toBase58();
    expect((await fetch(`${base}/chain/proposals/${unknown}`)).status).toBe(404);
    expect((await fetch(`${base}/chain/proposals/not-a-key`)).status).toBe(400);
  });

  it("is 501 when no chain reader is configured", async () => {
    const base = await startApi();
    const res = await fetch(`${base}/chain/proposals/${knownProposal.toBase58()}`);
    expect(res.status).toBe(501);
  });
});

describe("GET /chain/dao/:realm", () => {
  it("serves the dashboard for realm+vault", async () => {
    const base = await startApi(fakeReader());
    const res = await fetch(
      `${base}/chain/dao/${knownRealm.toBase58()}?vault=${vault.toBase58()}`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dashboard);
  });

  it("vault query param is required and must be a pubkey", async () => {
    const base = await startApi(fakeReader());
    expect(
      (await fetch(`${base}/chain/dao/${knownRealm.toBase58()}`)).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/chain/dao/${knownRealm.toBase58()}?vault=zzz`)).status,
    ).toBe(400);
  });

  it("unknown realm is 404; 501 without a reader", async () => {
    const base = await startApi(fakeReader());
    const unknown = Keypair.generate().publicKey.toBase58();
    expect(
      (await fetch(`${base}/chain/dao/${unknown}?vault=${vault.toBase58()}`)).status,
    ).toBe(404);
    const bare = await startApi();
    expect(
      (await fetch(`${bare}/chain/dao/${knownRealm.toBase58()}?vault=${vault.toBase58()}`)).status,
    ).toBe(501);
  });
});
