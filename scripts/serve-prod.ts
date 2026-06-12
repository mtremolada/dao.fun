/**
 * Production backend entrypoint — composes the REAL createApiHandler with
 * RPC-backed chain access, sqlite persistence, the PumpFun launch service,
 * holder snapshots, and the browser-signing tx builder. Halts at boot on
 * any missing/!invalid config (spec 11: halt-until-funded).
 *
 *   # env (see packages/backend/src/config.ts for the full contract)
 *   SOLANA_RPC_URL=https://...           # keyed RPC strongly recommended
 *   SOLANA_CLUSTER=mainnet-beta
 *   ARTIFACT_STORE=sqlite:./data/artifacts.db
 *   LAUNCH_STORE=sqlite:./data/launches.db
 *   PROTOCOL_TREASURY=<base58>
 *   LAUNCH_FEE_LAMPORTS=...
 *   LAUNCHER_KEYPAIR=./.wallets/mainnet-gas.json   # gas + launch fee + pump user
 *   HELIUS_URL=https://...               # optional, DAS holder snapshots
 *   GUARDED_ENABLED=false                # true needs GATE3_OVERRIDE_ACK on mainnet
 *   API_PORT=4404
 *
 *   npx tsx scripts/serve-prod.ts
 *
 * Pump fun is the only rail wired (operator scope, 2026-06-12). Meteora
 * (GATE 4) is intentionally absent.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { MINT_SIZE } from "@solana/spl-token";
import {
  DasHolderSnapshot,
  LaunchService,
  RpcChainReader,
  RpcGovernanceTxSource,
  RpcHolderSnapshot,
  SqliteArtifactStore,
  SqliteLaunchStore,
  createApiHandler,
  loadProdConfig,
  makeHolderSnapshotSource,
} from "../packages/backend/src";

function loadKeypair(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

async function main() {
  const cfg = loadProdConfig(process.env);
  const launcherPath = process.env.LAUNCHER_KEYPAIR;
  if (!launcherPath) throw new Error("missing required env LAUNCHER_KEYPAIR");
  const launcher = loadKeypair(launcherPath);

  const connection = new Connection(cfg.rpcUrl, "confirmed");

  // Halt-until-funded (spec 11): a launcher with no SOL cannot pay the
  // first instruction — fail loudly at boot, not mid-ceremony.
  const balance = await connection.getBalance(launcher.publicKey);
  if (balance === 0) {
    throw new Error(
      `launcher ${launcher.publicKey.toBase58()} has 0 lamports on ${cfg.cluster} — fund it before serving`,
    );
  }

  const councilMintRentLamports = BigInt(
    await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
  );

  const launchService = new LaunchService({
    connection,
    launcher,
    protocolTreasury: cfg.protocolTreasury,
    launchFeeLamports: cfg.launchFeeLamports,
    councilMintRentLamports,
  });

  const snapshot = makeHolderSnapshotSource({
    connection,
    ...(cfg.heliusUrl ? { heliusUrl: cfg.heliusUrl } : {}),
  });

  const handler = createApiHandler({
    launchStore: new SqliteLaunchStore(cfg.launchStore.slice("sqlite:".length)),
    artifactStore: SqliteArtifactStore.fromEnv(cfg.artifactStore),
    buildSteps: launchService.buildSteps,
    chain: new RpcChainReader(connection),
    txs: new RpcGovernanceTxSource(connection),
    snapshot,
    guardedEnabled: cfg.guardedEnabled,
    requireTokenMetadata: true,
  });

  createServer(handler).listen(cfg.apiPort, () => {
    console.log(
      `daofun api on :${cfg.apiPort} cluster=${cfg.cluster} ` +
        `launcher=${launcher.publicKey.toBase58()} balance=${balance} ` +
        `guarded=${cfg.guardedEnabled ? "ENABLED" : "locked"} ` +
        `snapshot=${snapshot instanceof DasHolderSnapshot ? "das" : snapshot instanceof RpcHolderSnapshot ? "rpc" : "?"}`,
    );
  });
}

void main().catch((e) => {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
});
