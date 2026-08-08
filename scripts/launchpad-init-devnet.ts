/**
 * Initialize the launchpad config on devnet (RUNBOOK D4). Sends
 * initialize_config with the devnet-scaled economics profile and the CANONICAL
 * devnet Raydium addresses, then reads the config back to verify.
 *
 *   LAUNCHPAD_PROGRAM_ID=<id> RPC_URL=<helius-devnet> \
 *   AUTHORITY_KEYPAIR=.wallets/deployer.json FEE_RECIPIENT=<pubkey> \
 *   npx tsx scripts/launchpad-init-devnet.ts
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  DEVNET_SCALED,
  buildInitializeConfigIx,
  configPda,
  decodeConfig,
  raydiumCpmmAddresses,
} from "@daofun/sdk";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

async function main(): Promise<void> {
  const programId = new PublicKey(env("LAUNCHPAD_PROGRAM_ID"));
  const connection = new Connection(env("RPC_URL"), "confirmed");
  const authority = loadKeypair(env("AUTHORITY_KEYPAIR"));
  const feeRecipient = new PublicKey(env("FEE_RECIPIENT"));
  const ray = raydiumCpmmAddresses("devnet");

  const ix = buildInitializeConfigIx({
    payer: authority.publicKey,
    authority: authority.publicKey,
    feeRecipient,
    params: {
      protocolFeeBps: DEVNET_SCALED.protocolFeeBps,
      creatorFeeBps: DEVNET_SCALED.creatorFeeBps,
      graduationFeeLamports: 0n,
      initialVirtualSol: DEVNET_SCALED.initialVirtualSol,
      initialVirtualToken: DEVNET_SCALED.initialVirtualToken,
      initialRealToken: DEVNET_SCALED.initialRealToken,
      tokenTotalSupply: DEVNET_SCALED.tokenTotalSupply,
    },
    cluster: "devnet",
    programId,
    ray,
  });

  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [authority], {
    commitment: "confirmed",
  });
  console.log("initialize_config:", sig);

  const info = await connection.getAccountInfo(configPda(programId));
  if (!info) throw new Error("config account not found after init");
  const cfg = decodeConfig(info.data);
  console.log("verified config:", {
    authority: cfg.authority.toBase58(),
    feeRecipient: cfg.feeRecipient.toBase58(),
    protocolFeeBps: cfg.protocolFeeBps,
    creatorFeeBps: cfg.creatorFeeBps,
    cpmmProgram: cfg.cpmmProgram.toBase58(),
    cpmmAmmConfig: cfg.cpmmAmmConfig.toBase58(),
    initialVirtualSol: cfg.initialVirtualSol.toString(),
  });
  if (!cfg.cpmmProgram.equals(ray.program)) throw new Error("cpmm program mismatch — wrong cluster addresses");
  console.log("OK — launchpad initialized on devnet.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
