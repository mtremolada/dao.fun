/**
 * Production configuration — spec Section 3 (env contract) + Section 11
 * (key management). Pure parsing/validation so it is unit-tested offline;
 * the server entrypoints (scripts/serve-*.ts) call loadProdConfig() once
 * at boot and HALT on any missing/!invalid value rather than starting
 * half-configured (spec 11: "halt-until-funded").
 *
 * Env contract:
 *   SOLANA_RPC_URL        required; the cluster the server transacts on
 *   SOLANA_CLUSTER        "mainnet-beta" | "devnet" (gates guarded — see below)
 *   ARTIFACT_STORE        sqlite:<path>  (spec 12.3)
 *   LAUNCH_STORE          sqlite:<path>  (step-machine resumability, 6.6)
 *   PROTOCOL_TREASURY     base58; receives the flat launch fee
 *   LAUNCH_FEE_LAMPORTS   integer >= 0
 *   HELIUS_URL            optional; DAS holder snapshots (else public-RPC gPA)
 *   GUARDED_ENABLED       "true" unlocks Guarded launches (D-034 override).
 *                         REFUSED on mainnet unless GATE3_OVERRIDE_ACK is set
 *                         to the exact ack string — the audit precondition is
 *                         the operator's to override, loudly, not a silent env.
 *   GATE3_OVERRIDE_ACK    must equal GATE3_ACK_STRING to enable guarded on
 *                         mainnet without the external audit.
 *   API_PORT              optional; default 4404
 */
import { PublicKey } from "@solana/web3.js";

export const GATE3_ACK_STRING =
  "I-am-deploying-an-unaudited-program-to-mainnet";

export interface ProdConfig {
  rpcUrl: string;
  cluster: "mainnet-beta" | "devnet";
  artifactStore: string;
  launchStore: string;
  protocolTreasury: PublicKey;
  launchFeeLamports: bigint;
  heliusUrl?: string;
  guardedEnabled: boolean;
  apiPort: number;
}

export type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string {
  const v = env[key];
  if (v === undefined || v.trim() === "") {
    throw new Error(`missing required env ${key}`);
  }
  return v.trim();
}

export function loadProdConfig(env: Env): ProdConfig {
  const rpcUrl = req(env, "SOLANA_RPC_URL");
  const cluster = req(env, "SOLANA_CLUSTER");
  if (cluster !== "mainnet-beta" && cluster !== "devnet") {
    throw new Error(
      `SOLANA_CLUSTER must be "mainnet-beta" or "devnet" (got "${cluster}")`,
    );
  }

  const artifactStore = req(env, "ARTIFACT_STORE");
  if (!artifactStore.startsWith("sqlite:")) {
    throw new Error('ARTIFACT_STORE must be "sqlite:<path>"');
  }
  const launchStore = req(env, "LAUNCH_STORE");
  if (!launchStore.startsWith("sqlite:")) {
    throw new Error('LAUNCH_STORE must be "sqlite:<path>"');
  }

  let protocolTreasury: PublicKey;
  try {
    protocolTreasury = new PublicKey(req(env, "PROTOCOL_TREASURY"));
  } catch {
    throw new Error("PROTOCOL_TREASURY is not a valid base58 pubkey");
  }

  const feeRaw = req(env, "LAUNCH_FEE_LAMPORTS");
  if (!/^\d+$/.test(feeRaw)) {
    throw new Error("LAUNCH_FEE_LAMPORTS must be a non-negative integer");
  }
  const launchFeeLamports = BigInt(feeRaw);

  // Guarded gating: the program is unaudited (GATE 3 precondition). On
  // mainnet the operator must ACK the override explicitly; devnet is free.
  const guardedRequested = (env.GUARDED_ENABLED ?? "").toLowerCase() === "true";
  let guardedEnabled = false;
  if (guardedRequested) {
    if (cluster === "devnet") {
      guardedEnabled = true;
    } else if (env.GATE3_OVERRIDE_ACK === GATE3_ACK_STRING) {
      guardedEnabled = true;
    } else {
      throw new Error(
        "GUARDED_ENABLED=true on mainnet requires GATE3_OVERRIDE_ACK=" +
          GATE3_ACK_STRING +
          " (the proposal-gate program is not externally audited — GATE 3). " +
          "Set the ack to deploy it anyway, or leave guarded disabled.",
      );
    }
  }

  const portRaw = env.API_PORT ?? "4404";
  if (!/^\d+$/.test(portRaw)) {
    throw new Error("API_PORT must be an integer");
  }

  return {
    rpcUrl,
    cluster,
    artifactStore,
    launchStore,
    protocolTreasury,
    launchFeeLamports,
    ...(env.HELIUS_URL ? { heliusUrl: env.HELIUS_URL.trim() } : {}),
    guardedEnabled,
    apiPort: Number(portRaw),
  };
}
