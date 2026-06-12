/**
 * Thin HTTP API over the launch orchestrator — spec 6.6 wiring only.
 * No framework: a bare node:http request listener with injected deps so
 * the same handler runs in tests, dev, and prod. Forms are re-validated
 * server-side with the SAME shared functions the UI renders (spec 6.7).
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { PublicKey } from "@solana/web3.js";
import { proRataShares, validateLaunchForm, type LaunchFormInput } from "@daofun/sdk";
import {
  runLaunch,
  type LaunchStep,
  type LaunchStore,
} from "./launch-machine";
import type { ArtifactStore } from "./artifacts";
import { detectProposalAnomalies, type ChainReader } from "./chain-reader";
import type { HolderSnapshotSource } from "./holder-snapshot";

export interface ApiDeps {
  launchStore: LaunchStore;
  artifactStore: ArtifactStore;
  /** Builds the concrete steps for a validated launch (see launch-steps). */
  buildSteps: (launchId: string, form: LaunchFormInput) => LaunchStep[];
  /** RPC-backed in prod, fake in tests; /chain/* is 501 when absent. */
  chain?: ChainReader;
  /** Holder snapshots for `distribute` inputs; /snapshots is 501 when absent. */
  snapshot?: HolderSnapshotSource;
}

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
  for await (const chunk of req) chunks.push(chunk as Buffer);
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

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/launches") {
    let body: { launchId?: string; form?: LaunchFormInput };
    try {
      body = (await readBody(req)) as typeof body;
    } catch {
      return json(res, 400, { errors: ["invalid JSON body"] });
    }
    if (!body.launchId || !body.form) {
      return json(res, 400, { errors: ["launchId and form are required"] });
    }
    // Server floors are the contract — same functions as the UI.
    const validated = validateLaunchForm(body.form);
    if (!validated.ok) {
      return json(res, 400, { errors: validated.errors });
    }
    const state = await runLaunch(
      body.launchId,
      deps.buildSteps(body.launchId, body.form),
      deps.launchStore,
    );
    return json(res, state.status === "complete" ? 201 : 502, state);
  }

  if (req.method === "GET" && segments[0] === "launches" && segments.length === 2) {
    const state = await deps.launchStore.load(segments[1]!);
    return state ? json(res, 200, state) : json(res, 404, { error: "not found" });
  }

  if (req.method === "POST" && url.pathname === "/snapshots") {
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

  return json(res, 404, { error: "not found" });
}
