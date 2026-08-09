/**
 * Devnet smoke — the cheap regression a program upgrade actually needs.
 *
 * A redeploy cannot break the path it changed if that path does not run on
 * devnet (the locker is mainnet-only); what it CAN break is everything that
 * already worked. So this drives the live paths against the freshly deployed
 * binary on an existing coin — create a coin, buy, sell, sweep both fee
 * vaults — and checks the lamports rather than the absence of an error.
 *
 * Small on purpose: a full graduation costs ~2.83 devnet SOL permanently
 * (the raise becomes pool liquidity and the LP is burned), and three coins
 * have already been graduated. This costs a few thousandths of a SOL.
 *
 *   pnpm tsx scripts/devnet-smoke.ts            # trade an existing coin
 *   pnpm tsx scripts/devnet-smoke.ts --create   # also launch a fresh one
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
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  buildBuyIx,
  buildCollectCreatorFeeIx,
  buildCollectProtocolFeeIx,
  buildCreateCoinIx,
  buildSellIx,
  configPda,
  creatorVaultPda,
  curvePda,
  decodeConfig,
  decodeCurve,
  protocolVaultPda,
} from "../packages/sdk/src/launchpad";
import { buyQuote, sellQuote, tokensForSolInput } from "../packages/sdk/src/curve-math";

const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
const CREATE = process.argv.includes("--create");
const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

const signer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

const cu = (units = 400_000) =>
  ComputeBudgetProgram.setComputeUnitLimit({ units });

async function send(
  connection: Connection,
  payer: Keypair,
  ixs: Parameters<Transaction["add"]>,
  extra: Keypair[] = [],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [payer, ...extra], {
    commitment: "confirmed",
  });
}

async function readCurve(connection: Connection, mint: PublicKey) {
  const info = await connection.getAccountInfo(curvePda(mint, PROGRAM_ID));
  if (!info) throw new Error("no curve");
  return decodeCurve(info.data);
}

const curveState = (c: Awaited<ReturnType<typeof readCurve>>) => ({
  virtualSol: c.virtualSol,
  virtualToken: c.virtualToken,
  realSol: c.realSol,
  realToken: c.realToken,
  protocolFeeBps: c.protocolFeeBps,
  creatorFeeBps: c.creatorFeeBps,
  complete: c.complete,
});

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const payer = signer();
  const cfgInfo = await connection.getAccountInfo(configPda(PROGRAM_ID));
  const cfg = decodeConfig(cfgInfo!.data);
  console.log(`payer ${payer.publicKey.toBase58()}`);
  console.log(`start ${SOL(await connection.getBalance(payer.publicKey))} SOL\n`);

  let mint: PublicKey;
  let creator: PublicKey;

  if (CREATE) {
    const kp = Keypair.generate();
    const name = `Smoke ${new Date().toISOString().slice(11, 19)}`;
    console.log(`create — ${name} (${kp.publicKey.toBase58()})`);
    const sig = await send(
      connection,
      payer,
      [
        cu(600_000),
        buildCreateCoinIx({
          payer: payer.publicKey,
          mint: kp.publicKey,
          creator: payer.publicKey,
          name,
          symbol: "SMOKE",
          uri: "https://example.invalid/smoke.json",
          programId: PROGRAM_ID,
        }),
      ],
      [kp],
    );
    console.log(`  ${sig}`);
    mint = kp.publicKey;
    creator = payer.publicKey;

    // The bug this exists to catch: a coin whose protocol vault is not seeded
    // at creation cannot take a small buy, because the fee transfer would
    // create a below-rent account and the runtime rejects it.
    const vault = await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID));
    const floor = await connection.getMinimumBalanceForRentExemption(0);
    check(
      vault !== null && vault.lamports >= floor,
      "create seeds the protocol vault to the rent floor",
      vault ? `${vault.lamports}` : "missing",
    );
  } else {
    const curves = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [{ dataSize: CURVE_LEN }],
    });
    const live = curves
      .map((c) => decodeCurve(c.account.data))
      .filter((c) => !c.complete && !c.migrated);
    if (live.length === 0) throw new Error("no live coin to trade; pass --create");
    mint = live[0]!.mint;
    creator = live[0]!.creator;
    console.log(`trading existing coin ${mint.toBase58()}`);
  }

  // ---- buy ----
  const before = await readCurve(connection, mint);
  const budget = 10_000_000n; // 0.01 SOL
  const tokens = tokensForSolInput(curveState(before), budget);
  const expected = buyQuote(curveState(before), tokens);
  const ata = getAssociatedTokenAddressSync(mint, payer.publicKey, true);
  const balBefore = await connection.getBalance(payer.publicKey);

  console.log(`\nbuy — ${SOL(expected.totalCost)} SOL for ${tokens} base units`);
  const buySig = await send(connection, payer, [
    cu(),
    buildBuyIx({
      user: payer.publicKey,
      mint,
      creator,
      tokenAmount: tokens,
      maxSolCost: expected.totalCost,
      programId: PROGRAM_ID,
    }),
  ]);
  console.log(`  ${buySig}`);

  const afterBuy = await readCurve(connection, mint);
  const held = await connection.getTokenAccountBalance(ata);
  check(BigInt(held.value.amount) >= tokens, "the tokens arrived", held.value.amount);
  check(
    afterBuy.realSol - before.realSol === expected.curveCost,
    "the curve booked exactly the quoted raise",
    `${afterBuy.realSol - before.realSol} vs ${expected.curveCost}`,
  );
  // The fee split is the product's promise; check it landed, not that it ran.
  const protoVault = await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID));
  const creatorVault = await connection.getAccountInfo(creatorVaultPda(creator, PROGRAM_ID));
  check(protoVault !== null, "protocol vault exists after the buy");
  check(creatorVault !== null, "creator vault exists after the buy");
  const balAfter = await connection.getBalance(payer.publicKey);
  check(
    balBefore - balAfter >= Number(expected.totalCost),
    "the payer paid at least the quoted total (plus fees)",
    `${balBefore - balAfter}`,
  );

  // ---- sell it all back ----
  const sellAmount = BigInt(held.value.amount);
  const sq = sellQuote(curveState(afterBuy), sellAmount);
  console.log(`\nsell — ${sellAmount} base units for ${SOL(sq.netSol)} SOL net`);
  const sellSig = await send(connection, payer, [
    cu(),
    buildSellIx({
      user: payer.publicKey,
      mint,
      creator,
      tokenAmount: sellAmount,
      minSolOutput: sq.netSol,
      programId: PROGRAM_ID,
    }),
  ]);
  console.log(`  ${sellSig}`);
  const afterSell = await readCurve(connection, mint);
  check(
    afterSell.realToken === afterBuy.realToken + sellAmount,
    "the curve took the tokens back",
  );
  check(
    afterSell.realSol === afterBuy.realSol - sq.grossSol,
    "the curve paid out exactly the quoted gross",
    `${afterBuy.realSol - afterSell.realSol} vs ${sq.grossSol}`,
  );

  // ---- sweep the creator vault ----
  // Permissionless to call, fixed destination — the property that lets a DAO
  // treasury be a creator at all (GATE 0c).
  const creatorBefore = (await connection.getAccountInfo(creatorVaultPda(creator, PROGRAM_ID)))!
    .lamports;
  try {
    const sig = await send(connection, payer, [
      cu(),
      buildCollectCreatorFeeIx({ payer: payer.publicKey, creator, mint, programId: PROGRAM_ID }),
    ]);
    const creatorAfter = (await connection.getAccountInfo(creatorVaultPda(creator, PROGRAM_ID)))!
      .lamports;
    console.log(`\ncollect_creator_fee — ${sig}`);
    check(creatorAfter < creatorBefore, "the creator vault was swept", `${creatorBefore} -> ${creatorAfter}`);
  } catch (e) {
    check(false, "collect_creator_fee", (e as Error).message.slice(0, 120));
  }

  // ---- and the protocol vault, which must REFUSE to sweep the graduation
  // reserve while the coin has not migrated ----
  const protoBefore = (await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID)))!
    .lamports;
  try {
    await send(connection, payer, [
      cu(),
      buildCollectProtocolFeeIx({
        payer: payer.publicKey,
        mint,
        feeRecipient: cfg.feeRecipient,
        ammConfig: cfg.cpmmAmmConfig,
        programId: PROGRAM_ID,
      }),
    ]);
    const protoAfter = (await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID)))!
      .lamports;
    console.log(`\ncollect_protocol_fee — swept ${protoBefore - protoAfter} lamports`);
    check(false, "a pre-graduation sweep should have been refused", `${protoBefore} -> ${protoAfter}`);
  } catch (e) {
    // NothingToCollect is the CORRECT outcome: everything in the vault is
    // earmarked for this coin's own graduation until it migrates.
    const msg = (e as Error).message;
    check(
      /NothingToCollect|0x177a|custom program error/.test(msg),
      "the graduation reserve is protected from an early sweep",
      msg.replace(/\s+/g, " ").slice(0, 90),
    );
  }

  console.log(
    `\nend ${SOL(await connection.getBalance(payer.publicKey))} SOL — ` +
      (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
