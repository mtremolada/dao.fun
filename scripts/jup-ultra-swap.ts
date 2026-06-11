/**
 * One-shot Jupiter Ultra (RFQ/gasless-capable) swap: full USDC balance -> SOL.
 * Used once for the operator-overridden mainnet GATE 0a funding (DECISIONS.md
 * D-008). Taker signs; Ultra's fee payer covers gas on JupiterZ routes.
 */
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const ULTRA = "https://lite-api.jup.ag/ultra/v1";

async function main() {
  const kp = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(join(".wallets", "mainnet-gas.keypair.json"), "utf8")),
    ),
  );
  const owner = kp.publicKey;
  const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

  const usdcAccounts = await connection.getParsedTokenAccountsByOwner(owner, {
    mint: new PublicKey(USDC),
  });
  const amount = usdcAccounts.value[0]?.account.data.parsed.info.tokenAmount.amount;
  if (!amount || amount === "0") throw new Error("no USDC to swap");
  console.log(`swapping ${Number(amount) / 1e6} USDC -> SOL`);

  const orderRes = await fetch(
    `${ULTRA}/order?inputMint=${USDC}&outputMint=${WSOL}&amount=${amount}&taker=${owner.toBase58()}`,
  );
  const order = (await orderRes.json()) as {
    transaction?: string;
    requestId?: string;
    outAmount?: string;
    error?: string;
  };
  if (!order.transaction || !order.requestId) {
    throw new Error(`no executable order: ${JSON.stringify(order).slice(0, 400)}`);
  }
  console.log(`quote out: ${Number(order.outAmount) / 1e9} SOL`);

  const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  tx.sign([kp]);

  const execRes = await fetch(`${ULTRA}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
      requestId: order.requestId,
    }),
  });
  const exec = (await execRes.json()) as {
    status?: string;
    signature?: string;
    error?: string;
  };
  console.log("execute:", JSON.stringify(exec).slice(0, 400));
  if (exec.status !== "Success") throw new Error("swap did not succeed");

  const sol = await connection.getBalance(owner);
  console.log(`final SOL balance: ${sol / 1e9}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
