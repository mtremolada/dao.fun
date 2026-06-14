/**
 * Thin HTTP API over the launch orchestrator — spec 6.6 wiring only.
 * No framework: a bare node:http request listener with injected deps so
 * the same handler runs in tests, dev, and prod. Forms are re-validated
 * server-side with the SAME shared functions the UI renders (spec 6.7).
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  proRataShares,
  validateLaunchForm,
  validateTokenMetadata,
  type LaunchFormInput,
} from "@daofun/sdk";
import {
  runLaunch,
  type LaunchStep,
  type LaunchStore,
} from "./launch-machine";
import type { ArtifactStore } from "./artifacts";
import { detectProposalAnomalies, type ChainReader } from "./chain-reader";
import type { HolderSnapshotSource } from "./holder-snapshot";
import type { GovernanceTxSource } from "./tx-builder";
import type { TokenLaunchInput } from "./launch-steps";
import {
  toListingClaimVerificationWire,
  type ListingClaimVerifying,
} from "./enhanced-listing-source";

export interface ApiDeps {
  launchStore: LaunchStore;
  artifactStore: ArtifactStore;
  /** Builds the concrete steps for a validated launch (see launch-steps). */
  buildSteps: (
    launchId: string,
    form: LaunchFormInput,
    token?: TokenLaunchInput,
  ) => LaunchStep[];
  /** RPC-backed in prod, fake in tests; /chain/* is 501 when absent. */
  chain?: ChainReader;
  /** Holder snapshots for `distribute` inputs; /snapshots is 501 when absent. */
  snapshot?: HolderSnapshotSource;
  /** Unsigned-tx builder for browser signing (D-028); /chain/txs/* 501 when absent. */
  txs?: GovernanceTxSource;
  /** Payer-submitted listing-claim verifier (D-037); /chain/listing-claims/* 501 when absent. */
  listingClaim?: ListingClaimVerifying;
  /**
   * Bearer token guarding the MUTATING, server-funded routes (POST /launches,
   * POST /snapshots). `/launches` spends the server's launcher wallet, so it
   * MUST be gated in production. When unset the routes are open (dev/test);
   * set `API_AUTH_TOKEN` in any real deployment. The public browser routes
   * (GET /chain/*, /artifacts/*, POST /chain/txs/* — the user-signed voting
   * seam) are intentionally NOT gated.
   */
  authToken?: string;
  /**
   * Unlocks Guarded mode launches (D-034 operator override). Production
   * sets this only after the proposal-gate program is verified live on
   * the cluster this server points at. Default: locked.
   */
  guardedEnabled?: boolean;
  /**
   * Production launches must carry token metadata (name/symbol/uri for
   * the pump create). Stub/e2e servers leave this off.
   */
  requireTokenMetadata?: boolean;
}

/** Constant-time bearer check; open (true) only when no token is configured. */
function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length &&
    timingSafeEqual(presented, expected)
  );
}

/**
 * Cap request bodies so a hostile/buggy client cannot make the API buffer
 * unbounded memory. Every legitimate payload here (launch forms, signed
 * txs, pubkey lists) is a few KB at most; 256 KiB is generous headroom.
 */
const MAX_REQUEST_BODY_BYTES = 256 * 1024;

function json(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // Backstop for chunked encodings that omit content-length: stop reading
    // the moment the cap is crossed instead of buffering the whole stream.
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error("request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApiHandler(deps: ApiDeps): RequestListener {
  return (req, res) => {
    handle(req, res, deps).catch((e) => {
      json(res, 500, { error: (e as Error).message });
    });
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ApiDeps,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const segments = url.pathname.split("/").filter(Boolean);

  // Reject oversized payloads up front (the common, content-length-bearing
  // case) before any body is read; readBody enforces the same cap for
  // chunked requests that omit the header.
  if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BODY_BYTES) {
    return json(res, 413, { error: "request body too large" });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/launches") {
    // Server-funded: a launch spends the launcher wallet (treasury rent +
    // prefund + fee). Gate it whenever a token is configured.
    if (!isAuthorized(req, deps.authToken)) {
      return json(res, 401, { error: "unauthorized" });
    }
    let body: {
      launchId?: string;
      form?: LaunchFormInput;
      token?: TokenLaunchInput;
    };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return json(res, 400, { errors: ["invalid JSON body"] });
    }
    if (!body.launchId || !body.form) {
      return json(res, 400, { errors: ["launchId and form are required"] });
    }
    // Server floors are the contract — same functions as the UI.
    const validated = validateLaunchForm(body.form, {
      guardedEnabled: deps.guardedEnabled ?? false,
    });
    if (!validated.ok) {
      return json(res, 400, { errors: validated.errors });
    }
    if (deps.requireTokenMetadata) {
      const metaErrors = validateTokenMetadata(body.form.metadata);
      if (metaErrors.length > 0) {
        return json(res, 400, { errors: metaErrors });
      }
    }
    const state = await runLaunch(
      body.launchId,
      deps.buildSteps(body.launchId, body.form, body.token),
      deps.launchStore,
    );
    return json(res, state.status === "complete" ? 201 : 502, state);
  }

  if (req.method === "GET" && segments[0] === "launches" && segments.length === 2) {
    const state = await deps.launchStore.load(segments[1]!);
    return state ? json(res, 200, state) : json(res, 404, { error: "not found" });
  }

  if (req.method === "POST" && url.pathname === "/snapshots") {
    // Drives the holder snapshot (RPC cost) for a distribute proposal — a
    // privileged proposer action, not a public read. Gate it.
    if (!isAuthorized(req, deps.authToken)) {
      return json(res, 401, { error: "unauthorized" });
    }
    if (!deps.snapshot) {
      return json(res, 501, { error: "snapshot source not configured" });
    }
    let body: { mint?: string; totalLamports?: string; excludeOwners?: string[] };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    let mint: PublicKey;
    let totalLamports: bigint;
    let excludeOwners: PublicKey[];
    try {
      mint = new PublicKey(body.mint ?? "");
      totalLamports = BigInt(body.totalLamports ?? "");
      if (totalLamports <= 0n) throw new Error("non-positive");
      excludeOwners = (body.excludeOwners ?? []).map((o) => new PublicKey(o));
    } catch {
      return json(res, 400, {
        error:
          "mint and positive totalLamports are required (excludeOwners optional pubkeys)",
      });
    }
    const snap = await deps.snapshot.snapshotHolders(mint);
    let result;
    try {
      result = proRataShares({ holders: snap.holders, totalLamports, excludeOwners });
    } catch (e) {
      return json(res, 400, { error: (e as Error).message });
    }
    return json(res, 200, {
      slot: snap.slot,
      holderCount: snap.holders.length,
      heldSupply: result.heldSupply.toString(),
      allocatedLamports: result.allocatedLamports.toString(),
      dustLamports: result.dustLamports.toString(),
      // AUDIT F-11: token amount held by owners dropped as unclaimable
      // (off-curve PDAs — pools, vault, curve). Non-zero is expected and
      // healthy; it means that supply was correctly NOT allocated.
      unclaimableHeld: result.unclaimableHeld.toString(),
      shares: result.shares.map((s) => ({
        claimant: s.claimant.toBase58(),
        lamports: s.lamports.toString(),
      })),
    });
  }

  if (req.method === "GET" && segments[0] === "artifacts" && segments.length === 3) {
    let proposal: PublicKey;
    try {
      proposal = new PublicKey(segments[1]!);
    } catch {
      return json(res, 400, { error: "invalid proposal pubkey" });
    }
    const artifact = await deps.artifactStore.get(proposal, segments[2]!);
    return artifact
      ? json(res, 200, artifact)
      : json(res, 404, { error: "not found" });
  }

  // Browser-signing seam (D-028): unsigned-tx builders + raw submit.
  if (req.method === "POST" && segments[0] === "chain" && segments[1] === "txs") {
    if (!deps.txs) {
      return json(res, 501, { error: "tx source not configured" });
    }
    let body: Record<string, unknown>;
    try {
      body = (await readBody(req)) as Record<string, unknown>;
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }

    if (segments[2] === "deposit" && segments.length === 3) {
      let parsed;
      try {
        const amount = BigInt(String(body["amount"] ?? ""));
        if (amount <= 0n) throw new Error("non-positive");
        parsed = {
          realm: new PublicKey(String(body["realm"] ?? "")),
          governingTokenMint: new PublicKey(
            String(body["governingTokenMint"] ?? ""),
          ),
          wallet: new PublicKey(String(body["wallet"] ?? "")),
          amount,
          ...(body["tokenProgram"]
            ? { tokenProgram: new PublicKey(String(body["tokenProgram"])) }
            : {}),
        };
      } catch {
        return json(res, 400, {
          error: "realm, governingTokenMint, wallet, positive amount required",
        });
      }
      return json(res, 200, await deps.txs.depositTx(parsed));
    }

    if (segments[2] === "cast-vote" && segments.length === 3) {
      let parsed;
      try {
        parsed = {
          proposal: new PublicKey(String(body["proposal"] ?? "")),
          wallet: new PublicKey(String(body["wallet"] ?? "")),
          approve: Boolean(body["approve"]),
        };
      } catch {
        return json(res, 400, { error: "proposal and wallet pubkeys required" });
      }
      return json(res, 200, await deps.txs.castVoteTx(parsed));
    }

    if (segments[2] === "submit" && segments.length === 3) {
      const signed = body["signedTxBase64"];
      if (typeof signed !== "string" || signed.length === 0) {
        return json(res, 400, { error: "signedTxBase64 required" });
      }
      return json(res, 200, await deps.txs.submit(signed));
    }
  }

  if (req.method === "GET" && segments[0] === "chain") {
    if (!deps.chain) {
      return json(res, 501, { error: "chain reader not configured" });
    }

    if (segments[1] === "proposals" && segments.length === 3) {
      let proposal: PublicKey;
      try {
        proposal = new PublicKey(segments[2]!);
      } catch {
        return json(res, 400, { error: "invalid proposal pubkey" });
      }
      const state = await deps.chain.getProposalState(proposal);
      return state
        ? json(res, 200, { ...state, anomalies: detectProposalAnomalies(state) })
        : json(res, 404, { error: "not found" });
    }

    if (segments[1] === "dao" && segments.length === 3) {
      let realm: PublicKey;
      let vault: PublicKey;
      let wallet: PublicKey | undefined;
      try {
        realm = new PublicKey(segments[2]!);
        vault = new PublicKey(url.searchParams.get("vault") ?? "");
        const w = url.searchParams.get("wallet");
        wallet = w ? new PublicKey(w) : undefined;
      } catch {
        return json(res, 400, {
          error: "realm and ?vault= must be pubkeys (?wallet= optional)",
        });
      }
      const dashboard = await deps.chain.getDashboard(realm, { vault, wallet });
      return dashboard
        ? json(res, 200, dashboard)
        : json(res, 404, { error: "not found" });
    }
  }

  // Payer-submitted listing-claim verification (D-037): the payer hands over
  // BOTH the wallet signature and the payment tx hash; the verifier composes
  // ownership + on-chain payment + delivery into one verdict. Optional — the
  // serverless app verifies the signature client-side and treats this as an
  // authoritative on-chain enhancement.
  if (
    req.method === "POST" &&
    segments[0] === "chain" &&
    segments[1] === "listing-claims" &&
    segments[2] === "verify" &&
    segments.length === 3
  ) {
    if (!deps.listingClaim) {
      return json(res, 501, { error: "listing-claim verifier not configured" });
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: "invalid JSON body" });
    }
    const verdict = await deps.listingClaim.verifyClaim(body);
    return json(res, 200, toListingClaimVerificationWire(verdict));
  }

  return json(res, 404, { error: "not found" });
}
