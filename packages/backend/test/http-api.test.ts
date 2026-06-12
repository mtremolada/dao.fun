/**
 * Spec 6.6 — thin HTTP API over the orchestrator (wiring only; written
 * before implementation). The server re-validates launch forms with the
 * SAME shared functions the UI uses (spec 6.7: server floors are the
 * contract), runs the injected steps through the resumable machine, and
 * serves launch state + proposal artifacts.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import type { LaunchFormInput } from "@daofun/sdk";
import { createApiHandler, type ApiDeps } from "../src/http-api";
import { MemoryLaunchStore, type LaunchStep } from "../src/launch-machine";
import { MemoryArtifactStore } from "../src/artifacts";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

async function startApi(overrides: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    launchStore: new MemoryLaunchStore(),
    artifactStore: new MemoryArtifactStore(),
    buildSteps: (launchId) => [
      { name: "step-a", run: async () => [`${launchId}-sig-a`] },
      { name: "step-b", run: async () => [`${launchId}-sig-b`] },
    ],
    ...overrides,
  };
  server = createServer(createApiHandler(deps));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, deps };
}

const validForm: LaunchFormInput = {
  mode: "cypherpunk",
  tier: "micro",
  confirmations: { noVetoIrreversible: true },
};

describe("POST /launches", () => {
  it("re-validates the form server-side and rejects with the shared errors", async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        launchId: "l1",
        form: { mode: "cypherpunk", tier: "micro", confirmations: {} },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors.join()).toMatch(/confirmation/i);
  });

  it("runs the steps and returns the completed state", async () => {
    const { base, deps } = await startApi();
    const res = await fetch(`${base}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchId: "l2", form: validForm }),
    });
    expect(res.status).toBe(201);
    const state = (await res.json()) as {
      status: string;
      completedSteps: Record<string, string[]>;
    };
    expect(state.status).toBe("complete");
    expect(state.completedSteps["step-a"]).toEqual(["l2-sig-a"]);
    // and it persisted
    expect((await deps.launchStore.load("l2"))?.status).toBe("complete");
  });

  it("a failing step yields 502 with the resumable failed state persisted", async () => {
    const { base, deps } = await startApi({
      buildSteps: () => [
        { name: "ok", run: async () => ["sig"] },
        {
          name: "boom",
          run: async () => {
            throw new Error("rpc down");
          },
        },
      ] satisfies LaunchStep[],
    });
    const res = await fetch(`${base}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ launchId: "l3", form: validForm }),
    });
    expect(res.status).toBe(502);
    const state = (await res.json()) as { status: string; failedStep: string };
    expect(state.status).toBe("failed");
    expect(state.failedStep).toBe("boom");
    expect((await deps.launchStore.load("l3"))?.failedStep).toBe("boom");
  });

  it("malformed JSON is a 400, not a crash", async () => {
    const { base } = await startApi();
    const res = await fetch(`${base}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /launches/:id and /artifacts/:proposal/:hash", () => {
  it("serves persisted launch state; unknown id is 404", async () => {
    const { base, deps } = await startApi();
    await deps.launchStore.save({
      launchId: "seen",
      status: "complete",
      completedSteps: { x: ["sig"] },
    });
    const ok = await fetch(`${base}/launches/seen`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { status: string }).status).toBe("complete");
    expect((await fetch(`${base}/launches/never`)).status).toBe(404);
  });

  it("serves artifacts by proposal+hash; mismatched hash is 404 (INV-9 surface)", async () => {
    const { base, deps } = await startApi();
    const proposal = Keypair.generate().publicKey;
    await deps.artifactStore.put(proposal, "hash-1", {
      decodedSummary: "transfer 1 SOL",
      simulation: { ok: true },
      redFlags: [],
    });
    const ok = await fetch(`${base}/artifacts/${proposal.toBase58()}/hash-1`);
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { decodedSummary: string }).decodedSummary,
    ).toBe("transfer 1 SOL");
    expect(
      (await fetch(`${base}/artifacts/${proposal.toBase58()}/hash-2`)).status,
    ).toBe(404);
  });

  it("unknown routes are 404", async () => {
    const { base } = await startApi();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

describe("auth guard on the server-funded mutating routes", () => {
  const TOKEN = "s3cret-deploy-token";

  async function postLaunch(base: string, headers: Record<string, string> = {}) {
    return fetch(`${base}/launches`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ launchId: "auth-1", form: validForm }),
    });
  }

  it("rejects /launches without a valid bearer when a token is configured", async () => {
    const { base } = await startApi({ authToken: TOKEN });
    expect((await postLaunch(base)).status).toBe(401); // no header
    expect((await postLaunch(base, { authorization: "Bearer wrong" })).status).toBe(
      401,
    );
  });

  it("accepts /launches with the correct bearer", async () => {
    const { base } = await startApi({ authToken: TOKEN });
    const res = await postLaunch(base, { authorization: `Bearer ${TOKEN}` });
    expect(res.status).toBe(201); // the stub steps complete
  });

  it("is OPEN when no token is configured (dev/test default)", async () => {
    const { base } = await startApi();
    expect((await postLaunch(base)).status).toBe(201);
  });

  it("does NOT gate the public, user-signed routes (GET /chain is untouched)", async () => {
    const { base } = await startApi({ authToken: TOKEN });
    // no chain reader wired -> 501, NOT 401: the guard never ran on this route
    expect(
      (await fetch(`${base}/chain/proposals/11111111111111111111111111111111`))
        .status,
    ).toBe(501);
  });
});
