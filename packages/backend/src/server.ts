/**
 * Production entrypoint — the repo's first long-running service. Composes the
 * launchpad HTTP surface, the polling indexer, the graduation keeper, and the
 * SSE fan-out into one always-on process (one Railway service, not three).
 *
 *   node packages/backend/dist/server.js
 *
 * Everything is env-driven (see .env.example). Missing optional config just
 * disables that capability (its route 501s) rather than failing to boot.
 */
import { createServer } from "node:http";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  configPda,
  decodeConfig,
  buildMigrateIx,
  type Cluster,
} from "@daofun/sdk";
import { SqliteLaunchpadStore } from "./launchpad/store";
import { LaunchpadIndexer } from "./launchpad/indexer";
import { RpcTxSource } from "./launchpad/rpc-source";
import { SseHub } from "./launchpad/sse";
import { SelfHostUploader } from "./launchpad/metadata-uploader";
import { createLaunchpadHandler, type LaunchpadHandlerDeps } from "./launchpad/handler";
import { withCors, parseOrigins } from "./cors";
import { base58Decode } from "./base58";
import { log } from "./log";

/** "Already migrated" (by us earlier or by a stranger) is success, not error. */
const ALREADY_MIGRATED = /already migrated|already in use|AlreadyMigrated/i;

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`missing required env ${name}`);
  return v;
}

function loadKeypair(base58OrJson: string): Keypair {
  const trimmed = base58OrJson.trim();
  if (trimmed.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed) as number[]));
  }
  return Keypair.fromSecretKey(base58Decode(trimmed));
}

async function main(): Promise<void> {
  const cluster = env("CLUSTER", "devnet") as Cluster;
  const port = Number(env("PORT", "4500"));
  const rpcUrl = env("RPC_URL");
  const programId = new PublicKey(env("LAUNCHPAD_PROGRAM_ID"));
  const store = SqliteLaunchpadStore.fromEnv(env("LAUNCHPAD_STORE", "sqlite:.data/launchpad.db"));
  const connection = new Connection(rpcUrl, "confirmed");
  const sse = new SseHub({ heartbeatMs: Number(env("SSE_HEARTBEAT_MS", "25000")) });

  // Read the on-chain config once for the fee recipient the migrate needs.
  let feeRecipient: PublicKey | null = null;
  // The Raydium fee tier is address-checked by migrate and CAN change
  // (set_graduation_config); the cluster default goes stale the moment it
  // does, which is how the first live devnet graduation failed.
  let ammConfig: PublicKey | null = null;
  try {
    const cfg = await connection.getAccountInfo(configPda(programId));
    if (cfg) {
      const decoded = decodeConfig(cfg.data);
      feeRecipient = decoded.feeRecipient;
      ammConfig = decoded.cpmmAmmConfig;
    }
  } catch (e) {
    log.warn("could not read on-chain config; keeper migrate disabled until it appears", {
      err: (e as Error).message,
    });
  }

  const indexer = new LaunchpadIndexer({
    store,
    source: new RpcTxSource(connection, programId),
    sink: (event, ctx) => sse.broadcast({ event: `launchpad:${event.kind}`, data: { event, ...ctx } }),
    onError: (err, where) => log.error("indexer", { where, err: (err as Error).message }),
  });

  // Keeper: fee-payer only. Migrates completed, un-migrated curves. This
  // inlines the graduation crank (the decision core + tests live in
  // packages/keeper/src/graduation.ts for a standalone keeper deployment).
  const keeperKp = process.env.KEEPER_KEYPAIR ? loadKeypair(process.env.KEEPER_KEYPAIR) : null;

  async function sendAndConfirm(ix: TransactionInstruction, label: string): Promise<string> {
    if (!keeperKp) throw new Error("no keeper keypair");
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: keeperKp.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([keeperKp]);
    const sig = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    log.info("keeper sent", { label, sig });
    return sig;
  }

  async function keeperTick(): Promise<void> {
    if (!keeperKp || !feeRecipient) return;
    const candidates = store
      .listCoins({ filter: "graduating", limit: 200 })
      .filter((c) => c.complete === 1 && c.migrated === 0);
    for (const c of candidates) {
      const mint = new PublicKey(c.mint);
      try {
        const sig = await sendAndConfirm(
          buildMigrateIx({
            payer: keeperKp.publicKey,
            mint,
            feeRecipient,
            ...(ammConfig ? { ammConfig } : {}),
            cluster,
            programId,
          }),
          `migrate ${c.mint}`,
        );
        log.info("graduation", { mint: c.mint, status: "migrated", sig });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        log.info("graduation", {
          mint: c.mint,
          status: ALREADY_MIGRATED.test(msg) ? "already-migrated" : "error",
          err: ALREADY_MIGRATED.test(msg) ? undefined : msg,
        });
      }
    }
  }

  // Conditional spreads so an unset optional never becomes an explicit
  // `undefined` (exactOptionalPropertyTypes).
  const deps: LaunchpadHandlerDeps = {
    store,
    sse,
    healthExtra: () => ({ cluster }),
    ...(process.env.RPC_PROXY_UPSTREAM
      ? { rpcProxy: { upstreamUrl: env("RPC_PROXY_UPSTREAM") } }
      : {}),
    ...(process.env.AIRDROP_ENABLED === "1"
      ? {
          airdrop: {
            requestAirdrop: (pubkey: string, lamports: number) =>
              connection.requestAirdrop(new PublicKey(pubkey), lamports),
            solPerRequest: Number(env("AIRDROP_SOL", "1")),
            cooldownMs: Number(env("AIRDROP_COOLDOWN_HOURS", "8")) * 3600 * 1000,
            dailyCap: Number(env("AIRDROP_DAILY_CAP", "200")),
          },
        }
      : {}),
    ...(process.env.METADATA_DIR
      ? {
          metadata: {
            uploader: new SelfHostUploader(
              env("METADATA_DIR"),
              env("PUBLIC_BASE_URL", `http://localhost:${port}`),
            ),
          },
          metadataDir: process.env.METADATA_DIR,
        }
      : {}),
  };

  const handler = withCors(createLaunchpadHandler(deps), {
    origins: parseOrigins(process.env.CORS_ORIGINS),
  });
  const server = createServer(handler);
  server.listen(port, () => log.info("listening", { port, cluster, programId: programId.toBase58() }));

  const pollMs = Number(env("INDEXER_POLL_MS", "4000"));
  const timers = [
    setInterval(() => void indexer.runTick().catch((e) => log.error("tick", { err: (e as Error).message })), pollMs),
    setInterval(() => void keeperTick().catch((e) => log.error("keeper", { err: (e as Error).message })), pollMs * 3),
  ];

  const shutdown = () => {
    log.info("shutting down");
    for (const t of timers) clearInterval(t);
    sse.close();
    server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  log.error("fatal", { err: (e as Error).message });
  process.exit(1);
});
