/**
 * POST /chain/listing-claims/verify (D-037) — route wiring only; the verifier's
 * own logic (decode + ownership + payment + delivery) is unit-tested in
 * enhanced-listing-source.test.ts. Here we pin the contract: bigints serialized
 * to strings, negative verdict is 200 with ok:false, 400 on bad JSON, 501 when
 * no verifier is configured.
 */
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiHandler, type ApiDeps } from "../src/http-api";
import { MemoryLaunchStore } from "../src/launch-machine";
import { MemoryArtifactStore } from "../src/artifacts";
import type {
  ListingClaimVerification,
  ListingClaimVerifying,
} from "../src/enhanced-listing-source";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

const verdict: ListingClaimVerification = {
  ok: true,
  signatureValid: true,
  payment: {
    ok: true,
    signerMatches: true,
    amountSufficient: true,
    withinTimeWindow: true,
    observedOutflowLamports: 1_600_000_000n,
    observedUsdcOutflow: 0n,
    blockTime: 1_800_000_000,
    recipients: [{ address: "Helio11111111111111111111111111111111111111", lamports: 1_595_000_000n }],
    reasons: [],
  },
  delivery: { live: true, pending: false },
  reasons: [],
};

const fakeVerifier: ListingClaimVerifying = {
  async verifyClaim(raw) {
    return (raw as { reject?: boolean })?.reject
      ? { ...verdict, ok: false, signatureValid: false, reasons: ["forced"] }
      : verdict;
  },
};

async function startApi(listingClaim?: ListingClaimVerifying) {
  const deps: ApiDeps = {
    launchStore: new MemoryLaunchStore(),
    artifactStore: new MemoryArtifactStore(),
    buildSteps: () => [],
    listingClaim,
  };
  server = createServer(createApiHandler(deps));
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const post = (base: string, body: string) =>
  fetch(`${base}/chain/listing-claims/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("POST /chain/listing-claims/verify", () => {
  it("forwards the submission and serializes bigints (incl. recipients) to strings", async () => {
    const base = await startApi(fakeVerifier);
    const res = await post(base, JSON.stringify({ anything: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      payment: {
        observedOutflowLamports: string;
        observedUsdcOutflow: string;
        recipients: { lamports: string }[];
      };
    };
    expect(body.ok).toBe(true);
    expect(body.payment.observedOutflowLamports).toBe("1600000000");
    expect(body.payment.observedUsdcOutflow).toBe("0");
    expect(body.payment.recipients[0]!.lamports).toBe("1595000000");
  });

  it("returns the verifier's negative verdict as 200 with ok:false", async () => {
    const base = await startApi(fakeVerifier);
    const res = await post(base, JSON.stringify({ reject: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reasons: string[] };
    expect(body.ok).toBe(false);
    expect(body.reasons).toContain("forced");
  });

  it("is 400 on invalid JSON and 501 when no verifier is configured", async () => {
    const base = await startApi(fakeVerifier);
    expect((await post(base, "{not json")).status).toBe(400);
    const bare = await startApi();
    expect((await post(bare, "{}")).status).toBe(501);
  });
});
