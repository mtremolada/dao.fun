/**
 * GATE 0a continuation (mainnet, D-008): the create leg succeeded; the buyer
 * buy failed on a rent-floor edge. Resume: smaller third-party buy ->
 * permissionless keeper collect -> assert vault lamports strictly increase.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { OnlinePumpSdk, PumpSdk, getBuyTokenAmountFromSolAmount } from "@pump-fun/pump-sdk";
import BN from "bn.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derivePumpCreatorVault } from "../packages/sdk/src/pda";
import { loadOrCreateKeypair } from "./init-wallets";

const RPC_URL = "https://api.mainnet-beta.solana.com";
const MINT = new PublicKey("E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC");
const VAULT = new PublicKey("3qnu5xeFW2vwHPK116PccxwuBTqvQqfikp73tvVR4uJA");
const BUY_LAMPORTS = 6_000_000; // 0.006 SOL

const priorTxs = {
  "multisig-create":
    "65XXqYszYCWidRHujrW3jRs8aZZmyTRbmKxPittemvz2ZwVere9uM7gLDS5pJhraDZNR69mfhnYXvVpYDxXKVgRM",
  "rent-prefund-vaults":
    "2TBiz2sFgs24G1w9vmQQGMVdoBhcpTY7puAwShgrfTW5BKxa8Egmif4vR8UP2vbnn6Bp1xUC9o4V7Ur5gGsYpzQD",
  "create-v2-and-dev-buy":
    "2nHuT8LacbvqBveW4qegMxwRPJLZSBfWpk2xJsC5UbYmDDnstKiMKnmzth1fqZqA8hCTEgM23HZLsLXSN6dr7JsF",
};

async function sendTx(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  label: string,
  txs: Record<string, string>,
) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...ixs,
  );
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
  console.log(`  ${label}: ${sig}`);
  txs[label] = sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const keeper = loadOrCreateKeypair(".wallets", "mainnet-keeper");
  const buyer = loadOrCreateKeypair(".wallets", "mainnet-buyer");
  const txs: Record<string, string> = { ...priorTxs };
  const balances: Record<string, string> = {};

  const online = new OnlinePumpSdk(connection);
  const offline = new PumpSdk();
  const global = await online.fetchGlobal();

  // third-party buy (generates creator fees for the PDA creator)
  const buyState = await online.fetchBuyState(MINT, buyer.publicKey, TOKEN_2022_PROGRAM_ID);
  const buySol = new BN(BUY_LAMPORTS);
  const buyIxs = await offline.buyInstructions({
    global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint: MINT,
    user: buyer.publicKey,
    amount: getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: buyState.bondingCurve,
      amount: buySol,
      quoteMint: NATIVE_MINT,
    }),
    solAmount: buySol,
    slippage: 5,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  await sendTx(connection, buyIxs, buyer, "third-party-buy", txs);

  const creatorFeeVault = derivePumpCreatorVault(VAULT);
  balances["creator-fee-vault-before-collect"] = String(
    await connection.getBalance(creatorFeeVault),
  );
  const vaultBefore = await connection.getBalance(VAULT);
  balances["squads-vault-before-collect"] = String(vaultBefore);
  console.log(`accrued: ${balances["creator-fee-vault-before-collect"]} lamports; vault before: ${vaultBefore}`);

  // permissionless collect — keeper signs only as fee-payer (INV-2)
  const collectIxs = await online.collectCoinCreatorFeeV2Instructions(
    VAULT,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    keeper.publicKey,
  );
  for (const ix of collectIxs)
    for (const m of ix.keys)
      if (m.isSigner && !m.pubkey.equals(keeper.publicKey))
        throw new Error(`INV-2 violated: extra signer ${m.pubkey.toBase58()}`);
  await sendTx(connection, collectIxs, keeper, "permissionless-collect", txs);

  const vaultAfter = await connection.getBalance(VAULT);
  balances["squads-vault-after-collect"] = String(vaultAfter);
  console.log(`squads vault: ${vaultBefore} -> ${vaultAfter}`);

  const result = vaultAfter > vaultBefore ? "PASS" : "FAIL";
  console.log(`\nGATE 0a (mainnet): ${result}`);

  mkdirSync(".gate-evidence", { recursive: true });
  writeFileSync(
    join(".gate-evidence", "gate-0a-mainnet.json"),
    JSON.stringify(
      {
        gate: "0a",
        cluster: RPC_URL,
        note: "operator-overridden mainnet run (DECISIONS.md D-008); buyer leg resumed after rent-floor edge",
        mint: MINT.toBase58(),
        multisigPda: "5572XY2dwdq2srxLBRgDeVzUkNxuGcBafn9xqStko8q8",
        vaultPda: VAULT.toBase58(),
        predictedNativeTreasury: "FmGNFAZmRdNYnf9eGwcXysZCPM7PJDMUiT2W94kHLsuo",
        txs,
        balances,
        result,
      },
      null,
      2,
    ),
  );
  if (result === "FAIL") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
