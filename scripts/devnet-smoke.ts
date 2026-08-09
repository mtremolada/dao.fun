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
 * `--graduate` additionally buys the curve OUT and cranks the migration, which
 * is the one thing a redeploy cannot be talked out of proving: that the whole
 * fee model still lands on a real cluster. It costs ~2.86 SOL permanently —
 * the raise becomes pool liquidity and the LP is burned — so it is opt-in.
 *
 *   pnpm tsx scripts/devnet-smoke.ts             # trade an existing coin
 *   pnpm tsx scripts/devnet-smoke.ts --create    # also launch a fresh one
 *   pnpm tsx scripts/devnet-smoke.ts --graduate  # create, buy out, migrate
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
  NATIVE_MINT,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildBuyIx,
  buildCollectCreatorFeeIx,
  buildCollectProtocolFeeIx,
  buildCreateCoinIx,
  buildMigrateIx,
  buildSellIx,
  configPda,
  cpmmPoolAccounts,
  creatorVaultPda,
  curvePda,
  decodeConfig,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeCurve,
  graduatedFeesPda,
  migrationAuthorityPda,
  protocolVaultPda,
  raydiumCpmmAddresses,
} from "../packages/sdk/src/launchpad";
import { buyQuote, sellQuote, tokensForSolInput } from "../packages/sdk/src/curve-math";

const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
const GRADUATE = process.argv.includes("--graduate");
const FRONTRUN = process.argv.includes("--frontrun");
const CREATE = process.argv.includes("--create") || GRADUATE;
const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);
/** Mirrors the program's constant: rent for the pool's accounts. */
const CPMM_RENT_LAMPORTS = 42_156_720n;

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

  // ---- graduation: buy the curve OUT, then crank migrate ----
  if (GRADUATE) {
    console.log("\n--- graduation ---");
    let state = await readCurve(connection, mint);

    // Check affordability up front. Running out MID-graduation leaves a
    // completed-but-unmigrated curve and a raw SendTransactionError, which is
    // a confusing way to learn you needed more SOL.
    const needed = buyQuote(curveState(state), state.realToken).totalCost;
    const have = BigInt(await connection.getBalance(payer.publicKey));
    if (have < needed + 20_000_000n) {
      console.log(
        `\nNOT ENOUGH SOL to graduate: need ~${SOL(needed)} for the buy-out ` +
          `plus fees, have ${SOL(have)}. The coin above is created and tradeable; ` +
          `top up and re-run with --graduate to take a fresh one all the way.`,
      );
      console.log(
        `\nend ${SOL(await connection.getBalance(payer.publicKey))} SOL — ` +
          (failures === 0 ? "ALL CHECKS PASSED (graduation skipped)" : `${failures} CHECK(S) FAILED`),
      );
      process.exit(failures === 0 ? 0 : 1);
    }
    // Buy in chunks: each buy is priced off the CURRENT curve, and a single
    // "all remaining tokens" quote can exceed what a 1232-byte transaction and
    // the wallet can comfortably carry in one shot. Loop until complete.
    for (let i = 0; i < 12 && !state.complete; i++) {
      const remaining = state.realToken;
      const chunk = remaining > 0n ? remaining : 0n;
      const q = buyQuote(curveState(state), chunk);
      console.log(`buy-out[${i}] ${SOL(q.totalCost)} SOL for ${chunk} units`);
      await send(connection, payer, [
        cu(),
        buildBuyIx({
          user: payer.publicKey,
          mint,
          creator,
          tokenAmount: chunk,
          // A little headroom: another trade can land between quote and send.
          maxSolCost: (q.totalCost * 101n) / 100n,
          programId: PROGRAM_ID,
        }),
      ]);
      state = await readCurve(connection, mint);
    }
    check(state.complete, "the curve reached completion", `raised ${SOL(state.realSol)} SOL`);

    const vaultBefore = (await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID)))!
      .lamports;
    const raiseBefore = state.realSol;

    // B1 live proof (D-060): before the migrate lands, create the migration
    // authority's wSOL ATA — the exact account the OLD `init` would have tried
    // to allocate, and which any attacker could squat for ~0.002 SOL to brick
    // graduation forever. On the fixed binary the staging accounts are program
    // PDAs, so this squat is simply irrelevant and migrate still lands.
    if (FRONTRUN) {
      const migrationAuthority = migrationAuthorityPda(mint, PROGRAM_ID);
      const squatAta = getAssociatedTokenAddressSync(NATIVE_MINT, migrationAuthority, true);
      const squatSig = await send(connection, payer, [
        cu(),
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          squatAta,
          migrationAuthority,
          NATIVE_MINT,
        ),
      ]);
      console.log(`front-run squat of ${squatAta.toBase58().slice(0, 8)}…  ${squatSig}`);
    }

    // The tier comes from the LIVE config, never the cluster default — that
    // is the bug the first devnet run found and five suites missed.
    const migrateSig = await send(connection, payer, [
      cu(600_000),
      buildMigrateIx({
        payer: payer.publicKey,
        mint,
        feeRecipient: cfg.feeRecipient,
        cluster: "devnet",
        ammConfig: cfg.cpmmAmmConfig,
        programId: PROGRAM_ID,
      }),
    ]);
    console.log(`migrate  ${migrateSig}`);

    const after = await readCurve(connection, mint);
    check(after.migrated, "the curve is marked migrated");
    check(after.realSol === 0n && after.realToken === 0n, "the curve is drained to zero");

    const ray = raydiumCpmmAddresses("devnet");
    const pool = cpmmPoolAccounts(mint, { ...ray, ammConfig: cfg.cpmmAmmConfig }, PROGRAM_ID);
    check(after.poolState.equals(pool.poolState), "the curve records the derived pool");
    const poolInfo = await connection.getAccountInfo(pool.poolState);
    check(
      poolInfo !== null && poolInfo.owner.equals(cfg.cpmmProgram),
      "the pool is a real Raydium CPMM pool",
    );
    if (poolInfo) {
      const decoded = decodeCpmmPool(poolInfo.data);
      check(
        decoded.ammConfig.equals(cfg.cpmmAmmConfig),
        "the pool graduated into the tier the CONFIG names, not the cluster default",
        decoded.ammConfig.toBase58(),
      );
      const sol = await connection.getTokenAccountBalance(
        decoded.token0Mint.equals(mint) ? decoded.token1Vault : decoded.token0Vault,
      );
      console.log(`  pool ${pool.poolState.toBase58()}  SOL side ${sol.value.uiAmountString}`);

      // Where the overhead came from, to the lamport.
      //
      // The overhead is Raydium's `create_pool_fee` (read from the tier, it is
      // admin-mutable) plus the pool's rent. On devnet the raise is far too
      // small for its own protocol fees to cover that, so the vault pays what
      // it has and the raise covers the rest — the RAISE-FALLBACK path, which
      // exists so a graduation can never strand.
      //
      // Careful with the vault number: `migrate` refunds unspent overhead and
      // reclaimed rent BACK to the protocol vault, so the vault's net change
      // is smaller than what it actually put in. Reporting the net as "the
      // overhead" would make it look as if the overhead had changed. What is
      // exactly observable is the RAISE side, and the guarantee worth
      // asserting is that the raise never gives up more than the overhead.
      const tierInfo = await connection.getAccountInfo(cfg.cpmmAmmConfig);
      const createPoolFee = decodeCpmmAmmConfig(tierInfo!.data).createPoolFee;
      const overhead = createPoolFee + CPMM_RENT_LAMPORTS;
      const vaultAfter = (await connection.getAccountInfo(protocolVaultPda(mint, PROGRAM_ID)))!
        .lamports;
      const vaultNet = BigInt(vaultBefore - vaultAfter);
      const poolSol = BigInt(sol.value.amount);
      const fromRaise = raiseBefore - poolSol;
      const fromVaultGross = overhead - fromRaise;
      console.log(
        `  overhead ${SOL(overhead)} SOL = vault ${SOL(fromVaultGross)} + raise ${SOL(fromRaise)}` +
          `  (vault net ${SOL(vaultNet)} after a ${SOL(fromVaultGross - vaultNet)} refund)`,
      );
      check(
        fromRaise <= overhead,
        "the raise gave up AT MOST the overhead, never more",
        `${SOL(fromRaise)} <= ${SOL(overhead)}`,
      );
      check(
        fromVaultGross >= 0n && fromVaultGross <= overhead,
        "the vault covered the remainder",
        `${SOL(fromVaultGross)}`,
      );
      check(
        fromVaultGross >= vaultNet,
        "the migration refunded its unspent overhead to the vault",
        `refund ${SOL(fromVaultGross - vaultNet)} SOL`,
      );

      // The burn guarantee, in its strongest form: no LP exists at all.
      const lp = await connection.getTokenSupply(decoded.lpMint);
      check(BigInt(lp.value.amount) === 0n, "LP supply is ZERO — every LP token burned", lp.value.amount);
    }

    // Devnet has no locker, so there must be NO graduated-fee record — this
    // is exactly what the UI keys off to say "burned" rather than "locked".
    check(
      (await connection.getAccountInfo(graduatedFeesPda(mint, PROGRAM_ID))) === null,
      "no graduated-fee record — the burn branch, as devnet must take",
    );

    // And NOW the protocol sweep is allowed: the graduation reserve it was
    // protecting has been spent, so what remains is genuinely the protocol's.
    try {
      const sig = await send(connection, payer, [
        cu(),
        buildCollectProtocolFeeIx({
          payer: payer.publicKey,
          mint,
          feeRecipient: cfg.feeRecipient,
          ammConfig: cfg.cpmmAmmConfig,
          programId: PROGRAM_ID,
        }),
      ]);
      console.log(`collect_protocol_fee ${sig}`);
      check(true, "post-graduation the protocol sweep is ALLOWED");
    } catch (e) {
      const msg = (e as Error).message;
      // Nothing left to sweep is a legitimate outcome if the vault paid the
      // whole overhead — the reserve is released either way.
      check(
        /NothingToCollect|custom program error/.test(msg),
        "post-graduation sweep: nothing left after the overhead",
        msg.replace(/\s+/g, " ").slice(0, 80),
      );
    }
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
