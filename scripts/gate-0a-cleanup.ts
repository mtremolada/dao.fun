/**
 * GATE 0a mainnet cleanup (D-008): sell test tokens back to the curve, close
 * token ATAs (reclaim rent), close the USDC ATA, sweep all liquid lamports
 * from every role wallet back to the operator's wallet.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PumpSdk,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { loadOrCreateKeypair } from "./init-wallets";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const MINT = new PublicKey("E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC");
const RETURN_TO = new PublicKey("2aJKQetcRJDVcbXikYUUuPZByypPV46LWdCSm48sWzYk");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

async function send(connection: Connection, ixs: Parameters<Transaction["add"]>, payer: Keypair, label: string) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`${label}: ${sig}`);
}

async function sellAllAndClose(
  connection: Connection,
  online: OnlinePumpSdk,
  offline: PumpSdk,
  wallet: Keypair,
  label: string,
) {
  const ata = getAssociatedTokenAddressSync(
    MINT,
    wallet.publicKey,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const balResp = await connection
    .getTokenAccountBalance(ata)
    .catch(() => null);
  const raw = balResp?.value.amount ?? "0";
  if (raw !== "0") {
    const global = await online.fetchGlobal();
    const sellState = await online.fetchSellState(
      MINT,
      wallet.publicKey,
      TOKEN_2022_PROGRAM_ID,
    );
    const amount = new BN(raw);
    const solOut = getSellSolAmountFromTokenAmount({
      global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: sellState.bondingCurve,
      amount,
      quoteMint: NATIVE_MINT,
    });
    const ixs = await offline.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint: MINT,
      user: wallet.publicKey,
      amount,
      solAmount: solOut,
      slippage: 10,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      mayhemMode: false,
    });
    await send(
      connection,
      [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ...ixs,
      ],
      wallet,
      `${label}-sell`,
    );
  }
  // close the token ATA to reclaim rent
  const ataInfo = await connection.getAccountInfo(ata);
  if (ataInfo) {
    await send(
      connection,
      [
        createCloseAccountInstruction(
          ata,
          wallet.publicKey,
          wallet.publicKey,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      ],
      wallet,
      `${label}-close-ata`,
    );
  }
}

async function sweep(connection: Connection, wallet: Keypair, label: string) {
  const bal = await connection.getBalance(wallet.publicKey);
  const fee = 5000;
  if (bal <= fee) {
    console.log(`${label}: nothing to sweep (${bal})`);
    return;
  }
  await send(
    connection,
    [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: RETURN_TO,
        lamports: bal - fee,
      }),
    ],
    wallet,
    `${label}-sweep(${(bal - fee) / 1e9} SOL)`,
  );
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const online = new OnlinePumpSdk(connection);
  const offline = new PumpSdk();
  const deployer = loadOrCreateKeypair(".wallets", "mainnet-deployer");
  const keeper = loadOrCreateKeypair(".wallets", "mainnet-keeper");
  const buyer = loadOrCreateKeypair(".wallets", "mainnet-buyer");

  await sellAllAndClose(connection, online, offline, deployer, "deployer");
  await sellAllAndClose(connection, online, offline, buyer, "buyer");

  // close deployer's USDC ATA (empty after the swap) to reclaim rent
  const usdcAta = getAssociatedTokenAddressSync(USDC, deployer.publicKey);
  if (await connection.getAccountInfo(usdcAta)) {
    await send(
      connection,
      [createCloseAccountInstruction(usdcAta, deployer.publicKey, deployer.publicKey)],
      deployer,
      "deployer-close-usdc-ata",
    );
  }

  await sweep(connection, buyer, "buyer");
  await sweep(connection, keeper, "keeper");
  await sweep(connection, deployer, "deployer");

  console.log(`final return-wallet balance check:`);
  console.log(`  ${RETURN_TO.toBase58()}: ${(await connection.getBalance(RETURN_TO)) / 1e9} SOL`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
