/**
 * Devnet wallet initialization (spec Section 11).
 *
 * - Idempotent: existing keypair files are reused; airdrops are skipped when
 *   the target balance is already met.
 * - Secrets live only in .wallets/ (gitignored). The manifest contains public
 *   keys ONLY — no secret material is ever logged, committed, or manifested.
 * - Faucet requests retry with exponential backoff (devnet faucet is flaky).
 * - Council test keys are created only for council-mode devnet runs (pass
 *   --council N).
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_WALLETS = ["deployer", "keeper", "protocol-treasury", "buyer"] as const;

export interface InitWalletsOptions {
  dir: string; // secrets directory (gitignored)
  names: string[];
  targetLamports: bigint; // airdrop top-up target per wallet
  connection?: Connection; // omit to skip funding (offline mode)
  maxAirdropAttempts?: number;
  backoffMs?: number; // base backoff, doubles per attempt
  log?: (msg: string) => void;
}

export interface WalletManifestEntry {
  name: string;
  publicKey: string;
}

export function loadOrCreateKeypair(dir: string, name: string): Keypair {
  const path = join(dir, `${name}.keypair.json`);
  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export async function airdropWithBackoff(
  connection: Connection,
  pubkey: PublicKey,
  lamports: bigint,
  maxAttempts = 5,
  backoffMs = 2000,
  log: (msg: string) => void = () => {},
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const sig = await connection.requestAirdrop(pubkey, Number(lamports));
      const latest = await connection.getLatestBlockhash("confirmed");
      await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      return true;
    } catch (e) {
      const wait = backoffMs * 2 ** (attempt - 1);
      log(`airdrop attempt ${attempt}/${maxAttempts} failed (${(e as Error).message}); waiting ${wait}ms`);
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}

export async function initWallets(
  opts: InitWalletsOptions,
): Promise<WalletManifestEntry[]> {
  const log = opts.log ?? console.log;
  const manifest: WalletManifestEntry[] = [];

  for (const name of opts.names) {
    const kp = loadOrCreateKeypair(opts.dir, name);
    manifest.push({ name, publicKey: kp.publicKey.toBase58() });

    if (opts.connection) {
      const balance = BigInt(await opts.connection.getBalance(kp.publicKey));
      if (balance >= opts.targetLamports) {
        log(`${name}: ${kp.publicKey.toBase58()} already funded (${balance} lamports)`);
      } else {
        const need = opts.targetLamports - balance;
        log(`${name}: ${kp.publicKey.toBase58()} requesting ${need} lamports`);
        const ok = await airdropWithBackoff(
          opts.connection,
          kp.publicKey,
          need,
          opts.maxAirdropAttempts ?? 5,
          opts.backoffMs ?? 2000,
          log,
        );
        if (!ok) log(`${name}: airdrop FAILED after retries — fund manually or retry later`);
      }
    }
  }

  // Public keys only — never secret material (spec Section 11).
  const manifestPath = join(opts.dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function main() {
  const councilArg = process.argv.indexOf("--council");
  const councilCount = councilArg >= 0 ? Number(process.argv[councilArg + 1] ?? 0) : 0;
  const names = [
    ...BASE_WALLETS,
    ...Array.from({ length: councilCount }, (_, i) => `council-${i + 1}`),
  ];
  const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const offline = process.argv.includes("--offline");

  const manifest = await initWallets({
    dir: join(process.cwd(), ".wallets"),
    names,
    targetLamports: BigInt(2 * LAMPORTS_PER_SOL),
    ...(offline ? {} : { connection: new Connection(rpcUrl, "confirmed") }),
  });
  console.log(JSON.stringify(manifest, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
