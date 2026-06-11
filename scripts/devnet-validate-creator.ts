/**
 * GATE 0a — PDA creator + permissionless collect (spec Section 7, HARD STOP).
 *
 * Validates on devnet that:
 *   1. A Squads v4 vault PDA can be the pump `creator` (INV-1): the vault is
 *      configured at creation with its final sole member = the Realm's
 *      predicted native-treasury PDA (advance-derivation rule, INV-7).
 *   2. Trading accrues creator fees for that PDA creator.
 *   3. A third party (keeper wallet, never the creator) can trigger fee
 *      collection signing only as fee-payer (INV-2).
 *   ACCEPT iff the Squads vault lamports STRICTLY INCREASE after collect.
 *
 * Evidence (tx signatures, balances) is written to .gate-evidence/gate-0a.json
 * for transcription into GATES.md. On FAIL: STOP -> Section 9 pivot.
 *
 * Usage: pnpm gate:0a   (requires funded .wallets/ via pnpm init-wallets)
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  OnlinePumpSdk,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import * as multisig from "@sqds/multisig";
import BN from "bn.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveGovernanceChainFromMint,
  derivePumpCreatorVault,
} from "../packages/sdk/src/pda";
import { loadOrCreateKeypair } from "./init-wallets";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const EVIDENCE_DIR = join(process.cwd(), ".gate-evidence");

interface Evidence {
  gate: "0a";
  cluster: string;
  startedAt: string;
  mint?: string;
  multisigPda?: string;
  vaultPda?: string;
  predictedNativeTreasury?: string;
  txs: Record<string, string>;
  balances: Record<string, string>;
  result?: "PASS" | "FAIL";
  failReason?: string;
}

async function sendTx(
  connection: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  signers: Keypair[],
  label: string,
  evidence: Evidence,
): Promise<string> {
  // Tx hygiene (spec Section 3): compute budget + priority fee on every tx.
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...ixs,
  );
  tx.feePayer = payer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [payer, ...signers], {
    commitment: "confirmed",
  });
  console.log(`  ${label}: ${sig}`);
  evidence.txs[label] = sig;
  return sig;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const evidence: Evidence = {
    gate: "0a",
    cluster: RPC_URL,
    startedAt: new Date().toISOString(),
    txs: {},
    balances: {},
  };

  const walletsDir = join(process.cwd(), ".wallets");
  const deployer = loadOrCreateKeypair(walletsDir, "deployer");
  const keeper = loadOrCreateKeypair(walletsDir, "keeper");
  const buyer = loadOrCreateKeypair(walletsDir, "buyer");

  for (const [name, kp] of [
    ["deployer", deployer],
    ["keeper", keeper],
    ["buyer", buyer],
  ] as const) {
    const bal = await connection.getBalance(kp.publicKey);
    console.log(`${name}: ${kp.publicKey.toBase58()} — ${bal / LAMPORTS_PER_SOL} SOL`);
    if (bal < 0.5 * LAMPORTS_PER_SOL) {
      throw new Error(`${name} underfunded (<0.5 SOL). Run: pnpm init-wallets`);
    }
  }

  // ---- Step 1: mint keypair + advance-derived governance chain ----
  const mint = Keypair.generate();
  const chain = deriveGovernanceChainFromMint(mint.publicKey);
  evidence.mint = mint.publicKey.toBase58();
  evidence.predictedNativeTreasury = chain.nativeTreasury.toBase58();
  console.log(`mint: ${evidence.mint}`);
  console.log(`predicted native treasury: ${evidence.predictedNativeTreasury}`);

  // ---- Step 2: Squads multisig, sole member = predicted native treasury ----
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  evidence.multisigPda = multisigPda.toBase58();
  evidence.vaultPda = vaultPda.toBase58();
  console.log(`multisig: ${evidence.multisigPda}`);
  console.log(`vault (pump creator): ${evidence.vaultPda}`);

  const programConfigPda = multisig.getProgramConfigPda({})[0];
  const programConfig =
    await multisig.accounts.ProgramConfig.fromAccountAddress(
      connection,
      programConfigPda,
    );

  const createMsIx = multisig.instructions.multisigCreateV2({
    treasury: programConfig.treasury,
    creator: deployer.publicKey,
    multisigPda,
    configAuthority: null, // config final at creation (spec 6.2)
    threshold: 1,
    members: [
      {
        key: chain.nativeTreasury,
        permissions: multisig.types.Permissions.all(),
      },
    ],
    timeLock: 0,
    createKey: createKey.publicKey,
    rentCollector: null,
  });
  await sendTx(connection, [createMsIx], deployer, [createKey], "multisig-create", evidence);

  // Assert sole-member configuration on-chain before proceeding.
  const ms = await multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
  if (
    ms.members.length !== 1 ||
    !new PublicKey(ms.members[0]!.key).equals(chain.nativeTreasury) ||
    ms.threshold !== 1
  ) {
    throw new Error("multisig config mismatch: sole-member prediction violated");
  }
  console.log("  ✓ sole member == predicted native-treasury PDA, threshold 1");

  // ---- Step 3: pump createV2 with creator = vault PDA + dev buy ----
  const onlineSdk = new OnlinePumpSdk(connection);
  const offlineSdk = new PumpSdk();
  const global = await onlineSdk.fetchGlobal();

  const devBuySol = new BN(0.02 * LAMPORTS_PER_SOL);
  const createIxs = await offlineSdk.createV2AndBuyInstructions({
    global,
    mint: mint.publicKey,
    name: "GATE0A Validation",
    symbol: "G0A",
    uri: "https://example.com/gate0a.json",
    creator: vaultPda, // INV-1: creator is the Squads vault PDA, never a wallet
    user: deployer.publicKey,
    amount: getBuyTokenAmountFromSolAmount({
      global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: null,
      amount: devBuySol,
      quoteMint: NATIVE_MINT,
    }),
    solAmount: devBuySol,
    mayhemMode: false,
  });
  await sendTx(connection, createIxs, deployer, [mint], "create-v2-and-dev-buy", evidence);

  // ---- Step 4: third-party buy generates creator fees ----
  const buySol = new BN(0.05 * LAMPORTS_PER_SOL);
  // createV2 mints are Token-2022 (see pump-sdk createV2Instruction source).
  const buyState = await onlineSdk.fetchBuyState(
    mint.publicKey,
    buyer.publicKey,
    TOKEN_2022_PROGRAM_ID,
  );
  const buyIxs = await offlineSdk.buyInstructions({
    global,
    bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
    bondingCurve: buyState.bondingCurve,
    associatedUserAccountInfo: buyState.associatedUserAccountInfo,
    mint: mint.publicKey,
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
  await sendTx(connection, buyIxs, buyer, [], "third-party-buy", evidence);

  const creatorVault = derivePumpCreatorVault(vaultPda);
  const accruedBefore = await connection.getBalance(creatorVault);
  const vaultBefore = await connection.getBalance(vaultPda);
  evidence.balances["creator-fee-vault-before-collect"] = String(accruedBefore);
  evidence.balances["squads-vault-before-collect"] = String(vaultBefore);
  console.log(`accrued creator fees: ${accruedBefore} lamports`);

  // ---- Step 5: permissionless collect, keeper signs ONLY as fee-payer ----
  const collectIxs = await onlineSdk.collectCoinCreatorFeeV2Instructions(
    vaultPda,
    NATIVE_MINT,
    TOKEN_PROGRAM_ID,
    keeper.publicKey,
  );
  // INV-2 assertion: the only required signer across collect ixs is the keeper.
  for (const ix of collectIxs) {
    for (const meta of ix.keys) {
      if (meta.isSigner && !meta.pubkey.equals(keeper.publicKey)) {
        throw new Error(
          `INV-2 violated: collect requires signer ${meta.pubkey.toBase58()}`,
        );
      }
    }
  }
  await sendTx(connection, collectIxs, keeper, [], "permissionless-collect", evidence);

  // ---- Accept criterion: vault lamports strictly increase ----
  const vaultAfter = await connection.getBalance(vaultPda);
  evidence.balances["squads-vault-after-collect"] = String(vaultAfter);
  console.log(`squads vault: ${vaultBefore} -> ${vaultAfter} lamports`);

  if (vaultAfter > vaultBefore) {
    evidence.result = "PASS";
    console.log("\nGATE 0a: PASS — vault lamports strictly increased.");
  } else {
    evidence.result = "FAIL";
    evidence.failReason = "vault lamports did not increase after collect";
    console.log("\nGATE 0a: FAIL — STOP. Section 9 pivot (Meteora DBC rail).");
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, "gate-0a.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(`evidence written to .gate-evidence/gate-0a.json`);
  if (evidence.result === "FAIL") process.exit(1);
}

main().catch((e) => {
  console.error("GATE 0a errored:", e);
  process.exit(1);
});
