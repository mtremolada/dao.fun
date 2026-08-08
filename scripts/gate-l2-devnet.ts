/**
 * GATE L2 — end-to-end on devnet (RUNBOOK D5). Launches a coin, buys it to
 * completion, cranks migrate, and verifies the real Raydium pool with a burned
 * LP. Emits evidence to stdout for GATES.md.
 *
 *   LAUNCHPAD_PROGRAM_ID=<id> RPC_URL=<helius-devnet> \
 *   PAYER_KEYPAIR=.wallets/deployer.json FEE_RECIPIENT=<pubkey> \
 *   npx tsx scripts/gate-l2-devnet.ts
 *
 * Requires the config to be initialized (scripts/launchpad-init-devnet.ts) and
 * the payer funded with ~4 devnet SOL (scaled curve completes near 2.83 SOL).
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  DEVNET_SCALED,
  buildBuyIx,
  buildCreateCoinIx,
  buildMigrateIx,
  configPda,
  curvePda,
  cpmmPoolAccounts,
  decodeConfig,
  decodeCurve,
  raiseAtCompletion,
} from "@daofun/sdk";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
const loadKeypair = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

async function send(connection: Connection, ixs: Parameters<Transaction["add"]>, signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...(ixs as never[]));
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}

async function main(): Promise<void> {
  const programId = new PublicKey(env("LAUNCHPAD_PROGRAM_ID"));
  const connection = new Connection(env("RPC_URL"), "confirmed");
  const payer = loadKeypair(env("PAYER_KEYPAIR"));
  const feeRecipient = new PublicKey(env("FEE_RECIPIENT"));

  const cfgInfo = await connection.getAccountInfo(configPda(programId));
  if (!cfgInfo) throw new Error("config not initialized — run launchpad-init-devnet.ts first");
  const cfg = decodeConfig(cfgInfo.data);
  console.log("cpmm program:", cfg.cpmmProgram.toBase58());

  const mint = Keypair.generate();
  console.log("mint:", mint.publicKey.toBase58());

  // 1. create
  const createSig = await send(
    connection,
    [
      cu(300_000),
      buildCreateCoinIx({
        payer: payer.publicKey,
        mint: mint.publicKey,
        creator: payer.publicKey,
        name: "Gate L2 Coin",
        symbol: "GL2",
        uri: "https://arweave.net/placeholder",
        programId,
      }),
    ] as never,
    [payer, mint],
  );
  console.log("create_coin:", createSig);

  // 2. buy the whole sellable reserve → completes the curve
  const buySig = await send(
    connection,
    [
      cu(120_000),
      buildBuyIx({
        user: payer.publicKey,
        mint: mint.publicKey,
        creator: payer.publicKey,
        feeRecipient,
        tokenAmount: DEVNET_SCALED.initialRealToken,
        maxSolCost: (raiseAtCompletion(DEVNET_SCALED) * 3n) / 2n, // headroom for fees
        programId,
      }),
    ] as never,
    [payer],
  );
  console.log("buy-to-completion:", buySig);

  const completed = decodeCurve((await connection.getAccountInfo(curvePda(mint.publicKey, programId)))!.data);
  console.log("complete:", completed.complete, "raised lamports:", completed.realSol.toString());
  if (!completed.complete) throw new Error("curve did not complete");

  // 3. migrate (permissionless)
  const migrateSig = await send(
    connection,
    [
      cu(1_400_000),
      buildMigrateIx({ payer: payer.publicKey, mint: mint.publicKey, feeRecipient, cluster: "devnet", programId }),
    ] as never,
    [payer],
  );
  console.log("migrate:", migrateSig);

  // 4. verify the pool + burned LP
  const pool = cpmmPoolAccounts(mint.publicKey, raydiumFor(cfg.cpmmProgram), programId);
  const poolAcc = await connection.getAccountInfo(pool.poolState);
  if (!poolAcc) throw new Error("pool_state not created");
  const lpMintAcc = await connection.getAccountInfo(pool.lpMint);
  const lpSupply = lpMintAcc ? Buffer.from(lpMintAcc.data).readBigUInt64LE(36) : -1n;
  console.log("pool owner:", new PublicKey(poolAcc.owner).toBase58());
  console.log("lp supply (0 == burned):", lpSupply.toString());

  const migrated = decodeCurve((await connection.getAccountInfo(curvePda(mint.publicKey, programId)))!.data);
  console.log("migrated:", migrated.migrated, "pool:", migrated.poolState.toBase58());

  if (!migrated.migrated || lpSupply !== 0n) throw new Error("graduation verification failed");
  console.log("\nGATE L2 PASS — real Raydium pool seeded, LP burned. Evidence above → GATES.md.");
}

// Build the RaydiumCpmmAddresses shape for cpmmPoolAccounts from the config's
// program; the child PDAs derive from the pool_state we sign, not these.
function raydiumFor(program: PublicKey) {
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_and_lp_mint_auth_seed")],
    program,
  );
  return { program, ammConfig: program, createPoolFeeReceiver: program, authority };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
