/**
 * Recover devnet SOL that testing left stranded.
 *
 * Read-only by default: it prints every lamport it can see, says who can
 * actually claim it, and does nothing. `--apply` performs only the recoveries
 * that destroy nothing:
 *
 *   - **empty token accounts** — each holds 2,039,280 lamports of rent and
 *     nothing else. Closing one is pure recovery.
 *   - **creator fee vaults** we own — `collect_creator_fee` sweeps everything
 *     above the rent floor to the creator.
 *   - **protocol fee vaults** of MIGRATED coins — `collect_protocol_fee`
 *     sweeps to `config.fee_recipient`. Pre-graduation vaults are deliberately
 *     skipped: that balance is the migration reserve, and the program refuses
 *     the sweep anyway.
 *
 * `--sell` liquidates positions that HAVE a market before recovering rent: a
 * graduated coin sells into its Raydium pool, a coin still on its curve sells
 * back to the curve. This is where nearly all of the recoverable value is, and
 * skipping it is the expensive mistake — see the guard below.
 *
 * `--burn` burns leftover tokens so their accounts can be closed. It **refuses
 * to burn anything with a live market**, no matter what flags are passed.
 *
 * That refusal is not defensive programming, it is a scar. The first run of
 * this script burned seven positions to reclaim 0.014 SOL of account rent;
 * four of them were graduated coins whose Raydium pools would have paid
 * **8.42 SOL**, and the other three sat on live curves worth 0.61 SOL more.
 * Nine SOL destroyed to recover fourteen thousandths, because "recover the
 * rent" was mistaken for "recover the value". A recovery tool that can do that
 * is worse than no recovery tool, so the market check now runs first and the
 * burn cannot proceed past it.
 *
 * Two things it will NOT do, and reports instead:
 *
 *   - **closing the deployed programs.** That is the largest recoverable
 *     amount by far, and it would delete the deployment every gate in
 *     GATES.md is evidence about. It needs a human decision, not a flag.
 *   - **DAO treasuries.** Governance-owned by construction: the only way out
 *     is a proposal through the gate, which costs a voting window plus a
 *     hold-up to recover a fraction of a SOL.
 *
 *   pnpm tsx scripts/devnet-recover.ts [--apply] [--burn]
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  buildCollectCreatorFeeIx,
  buildCollectProtocolFeeIx,
  buildCpmmSwapBaseInputIx,
  buildSellIx,
  configPda,
  cpmmSwapBaseInputQuote,
  creatorVaultPda,
  curvePda,
  decodeConfig,
  decodeCpmmAmmConfig,
  decodeCpmmPool,
  decodeCurve,
  protocolVaultPda,
} from "../packages/sdk/src/launchpad";
import { sellQuote } from "../packages/sdk/src/curve-math";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const GATE_ID = new PublicKey("4UioBmH3WkwYbLN6tumLGrUpXGMwFwcaxt1jbUcZE7Cy");

const APPLY = process.argv.includes("--apply");
const BURN = process.argv.includes("--burn");
const SELL = process.argv.includes("--sell");

/** Curve account length — the size filter that keeps Config out of the scan. */
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
/** Rent floor for a vault PDA (a bare system account). */
const VAULT_RENT_FLOOR = 890_880n;

const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

const payer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

async function send(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
}


/** A token balance, with what the chain would actually pay for it. */
interface PricedPosition {
  address: PublicKey;
  mint: PublicKey;
  amount: bigint;
  lamports: number;
  /** Where it can be sold: a graduated pool, its live curve, or nowhere. */
  market: "pool" | "curve" | "none";
  /** Lamports a full exit would return, before slippage tolerance. */
  value: bigint;
  creator?: PublicKey;
  poolState?: PublicKey;
}

/**
 * What is this position worth?
 *
 * A launchpad coin always has a market: before graduation the curve itself
 * buys it back, and after graduation the Raydium pool does. Only a token with
 * no curve on this program — a governance test mint, say — is genuinely
 * worthless, and that is the ONLY thing this script will ever burn.
 */
async function pricePosition(
  connection: Connection,
  cfg: ReturnType<typeof decodeConfig>,
  h: { address: PublicKey; mint: PublicKey; amount: bigint; lamports: number },
): Promise<PricedPosition> {
  const base = { ...h, market: "none" as const, value: 0n };
  const curveInfo = await connection.getAccountInfo(curvePda(h.mint, PROGRAM_ID));
  if (!curveInfo) return base;
  const curve = decodeCurve(curveInfo.data);

  if (!curve.migrated) {
    const q = sellQuote(
      {
        virtualSol: curve.virtualSol,
        virtualToken: curve.virtualToken,
        realSol: curve.realSol,
        realToken: curve.realToken,
        protocolFeeBps: curve.protocolFeeBps,
        creatorFeeBps: curve.creatorFeeBps,
        complete: curve.complete,
      },
      h.amount,
    );
    return { ...h, market: "curve", value: q.netSol, creator: curve.creator };
  }

  const poolInfo = await connection.getAccountInfo(curve.poolState);
  if (!poolInfo) return base;
  const pool = decodeCpmmPool(poolInfo.data);
  const [solVault, tokenVault] = pool.token0Mint.equals(NATIVE_MINT)
    ? [pool.token0Vault, pool.token1Vault]
    : [pool.token1Vault, pool.token0Vault];
  const [solBal, tokBal] = await Promise.all([
    connection.getTokenAccountBalance(solVault),
    connection.getTokenAccountBalance(tokenVault),
  ]);
  const q = cpmmSwapBaseInputQuote({
    amountIn: h.amount,
    inputReserve: BigInt(tokBal.value.amount),
    outputReserve: BigInt(solBal.value.amount),
    // The fee comes from the AmmConfig the CONFIG names, not a constant: the
    // tier is settable, and pricing against the wrong one misquotes the exit.
    tradeFeeRate: await tradeFeeRateOf(connection, cfg.cpmmAmmConfig),
  });
  return { ...h, market: "pool", value: q.amountOut, poolState: curve.poolState };
}

/** The live trade fee of the tier the config names, read once and cached. */
let tradeFeeCache: { tier: string; rate: bigint } | null = null;
async function tradeFeeRateOf(connection: Connection, tier: PublicKey): Promise<bigint> {
  if (tradeFeeCache?.tier === tier.toBase58()) return tradeFeeCache.rate;
  const info = await connection.getAccountInfo(tier);
  if (!info) throw new Error(`AmmConfig ${tier.toBase58()} not found`);
  const rate = decodeCpmmAmmConfig(info.data).tradeFeeRate;
  tradeFeeCache = { tier: tier.toBase58(), rate };
  return rate;
}

/**
 * The instructions that turn a position back into SOL.
 *
 * Slippage is deliberately loose (5%): this is a cleanup tool exiting a
 * position it is about to abandon, so a sale that lands slightly worse than
 * quoted is strictly better than one that fails and leaves the tokens behind.
 */
async function sellIxs(
  connection: Connection,
  cfg: ReturnType<typeof decodeConfig>,
  p: PricedPosition,
  me: PublicKey,
): Promise<TransactionInstruction[]> {
  const minOut = (p.value * 95n) / 100n;
  if (p.market === "curve") {
    return [
      cu(),
      buildSellIx({
        user: me,
        mint: p.mint,
        creator: p.creator!,
        tokenAmount: p.amount,
        minSolOutput: minOut,
        programId: PROGRAM_ID,
      }),
    ];
  }
  const poolInfo = await connection.getAccountInfo(p.poolState!);
  const pool = decodeCpmmPool(poolInfo!.data);
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, me, true);
  return [
    cu(),
    createAssociatedTokenAccountIdempotentInstruction(me, wsolAta, me, NATIVE_MINT),
    buildCpmmSwapBaseInputIx({
      payer: me,
      cpmmProgram: cfg.cpmmProgram,
      poolState: p.poolState!,
      pool,
      inputMint: p.mint,
      inputTokenAccount: p.address,
      outputTokenAccount: wsolAta,
      amountIn: p.amount,
      minimumAmountOut: minOut,
    }),
    // Closing unwraps the proceeds (and the ATA rent) into plain SOL.
    createCloseAccountInstruction(wsolAta, me, me),
    // ...and the now-empty coin account is rent to reclaim too.
    createCloseAccountInstruction(p.address, me, me),
  ];
}

const cu = (units = 400_000) => ComputeBudgetProgram.setComputeUnitLimit({ units });

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const signer = payer();
  const me = signer.publicKey;
  const before = await connection.getBalance(me);
  console.log(`wallet ${me.toBase58()}`);
  console.log(`balance ${SOL(before)} SOL`);
  console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: read-only (pass --apply to act)\n");

  let recovered = 0n;

  // ---- 1. token accounts -------------------------------------------------
  const tokenAccounts = await connection.getTokenAccountsByOwner(me, {
    programId: TOKEN_PROGRAM_ID,
  });
  const empty: { address: PublicKey; lamports: number }[] = [];
  const held: { address: PublicKey; mint: PublicKey; amount: bigint; lamports: number }[] = [];
  for (const { pubkey, account } of tokenAccounts.value) {
    const mint = new PublicKey(account.data.subarray(0, 32));
    const amount = account.data.readBigUInt64LE(64);
    if (amount === 0n) empty.push({ address: pubkey, lamports: account.lamports });
    else held.push({ address: pubkey, mint, amount, lamports: account.lamports });
  }
  const emptyRent = empty.reduce((n, a) => n + BigInt(a.lamports), 0n);
  const heldRent = held.reduce((n, a) => n + BigInt(a.lamports), 0n);
  console.log(`token accounts: ${empty.length} empty (${SOL(emptyRent)} SOL of rent), ` +
    `${held.length} holding tokens (${SOL(heldRent)} SOL of rent)`);

  if (APPLY && empty.length > 0) {
    // Batched: each close is tiny, and one transaction per account would pay
    // more in fees than a couple of them return.
    for (let i = 0; i < empty.length; i += 12) {
      const slice = empty.slice(i, i + 12);
      const sig = await send(
        connection,
        signer,
        slice.map((a) => createCloseAccountInstruction(a.address, me, me)),
      );
      console.log(`  closed ${slice.length} empty account(s)  ${sig}`);
    }
    recovered += emptyRent;
  }

  // ---- 1b. price every position BEFORE deciding what to do with it -------
  // This ordering is the whole lesson: rent is the small number and the market
  // is the big one, so nothing may be destroyed before it has been valued.
  const cfgInfo = await connection.getAccountInfo(configPda(PROGRAM_ID));
  if (!cfgInfo) throw new Error("no config account");
  const cfg = decodeConfig(cfgInfo.data);

  const priced: PricedPosition[] = [];
  for (const h of held) {
    priced.push(await pricePosition(connection, cfg, h));
  }
  for (const p of priced) {
    const where =
      p.market === "pool" ? "graduated — sells into its Raydium pool"
      : p.market === "curve" ? "live curve — sells back to the curve"
      : "no market on this cluster";
    console.log(`  ${p.address.toBase58().slice(0, 8)}…  mint ${p.mint.toBase58().slice(0, 8)}…  ` +
      `${p.amount} units  rent ${SOL(p.lamports)}  → ${where}` +
      (p.value > 0n ? `, worth ${SOL(p.value)} SOL` : ""));
  }
  const sellable = priced.filter((p) => p.value > 0n);
  const worthless = priced.filter((p) => p.value === 0n);
  const marketValue = sellable.reduce((n, p) => n + p.value, 0n);
  if (sellable.length > 0) {
    console.log(`\n  positions worth ${SOL(marketValue)} SOL — ${SELL ? "selling" : "pass --sell to liquidate"}`);
  }

  if (APPLY && SELL) {
    for (const p of sellable) {
      try {
        const sig = await send(connection, signer, await sellIxs(connection, cfg, p, me));
        console.log(`  sold ${p.mint.toBase58().slice(0, 8)}… for ~${SOL(p.value)} SOL  ${sig}`);
        recovered += p.value;
      } catch (e) {
        console.log(`  sell ${p.mint.toBase58().slice(0, 8)}… FAILED — ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }

  if (APPLY && BURN) {
    // The guard. A position with a market is never burned, whatever the flags
    // say — burning one trades its full value for 0.002 SOL of rent.
    for (const p of worthless) {
      const sig = await send(connection, signer, [
        createBurnInstruction(p.address, p.mint, me, p.amount),
        createCloseAccountInstruction(p.address, me, me),
      ]);
      console.log(`  burned + closed ${p.address.toBase58().slice(0, 8)}… (no market)  ${sig}`);
      recovered += BigInt(p.lamports);
    }
    if (sellable.length > 0) {
      console.log(`  REFUSED to burn ${sellable.length} position(s) worth ${SOL(marketValue)} SOL — ` +
        `sell them with --sell first; their rent is ${SOL(sellable.reduce((n, p) => n + BigInt(p.lamports), 0n))} SOL`);
    }
  }

  // ---- 2. fee vaults -----------------------------------------------------
  const iAmFeeRecipient = cfg.feeRecipient.equals(me);
  console.log(`\nconfig.feeRecipient ${cfg.feeRecipient.toBase58()}` +
    `${iAmFeeRecipient ? " (me)" : " (NOT me — protocol fees are not mine to sweep)"}`);

  const curves = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: CURVE_LEN }],
  });
  console.log(`${curves.length} curve(s) on chain`);

  const creators = new Map<string, PublicKey>();
  for (const { account } of curves) {
    const cu = decodeCurve(account.data);
    creators.set(cu.creator.toBase58(), cu.creator);
  }

  for (const creator of creators.values()) {
    const vault = creatorVaultPda(creator, PROGRAM_ID);
    const info = await connection.getAccountInfo(vault);
    if (!info) continue;
    const claim = BigInt(info.lamports) - VAULT_RENT_FLOOR;
    const mine = creator.equals(me);
    if (claim <= 0n) continue;
    console.log(`creator vault ${creator.toBase58().slice(0, 8)}…  claimable ${SOL(claim)}` +
      `${mine ? "" : "  (not mine — only the creator can sweep it)"}`);
    if (APPLY && mine) {
      // The builder needs a curve to prove the creator's claim; any coin this
      // creator launched works, since the vault is per-CREATOR not per-coin.
      const anyMint = [...curves]
        .map((x) => decodeCurve(x.account.data))
        .find((x) => x.creator.equals(creator))!.mint;
      const sig = await send(connection, signer, [
        buildCollectCreatorFeeIx({
          payer: me,
          creator: me,
          mint: anyMint,
          programId: PROGRAM_ID,
        }),
      ]);
      console.log(`  swept  ${sig}`);
      recovered += claim;
    }
  }

  for (const { account } of curves) {
    const cu = decodeCurve(account.data);
    const vault = protocolVaultPda(cu.mint, PROGRAM_ID);
    const info = await connection.getAccountInfo(vault);
    if (!info) continue;
    const claim = BigInt(info.lamports) - VAULT_RENT_FLOOR;
    if (claim <= 0n) continue;
    if (!cu.migrated) {
      // Not a missed opportunity: this balance is the graduation reserve, and
      // the program refuses the sweep until migrate has spent it.
      console.log(`protocol vault ${cu.mint.toBase58().slice(0, 8)}…  ${SOL(claim)} — RESERVED (not yet migrated)`);
      continue;
    }
    console.log(`protocol vault ${cu.mint.toBase58().slice(0, 8)}…  claimable ${SOL(claim)}`);
    if (APPLY && iAmFeeRecipient) {
      const sig = await send(connection, signer, [
        buildCollectProtocolFeeIx({
          payer: me,
          mint: cu.mint,
          feeRecipient: cfg.feeRecipient,
          // Address-checked by the program against the config, so it has to be
          // the tier the config NAMES, not the cluster default.
          ammConfig: cfg.cpmmAmmConfig,
          programId: PROGRAM_ID,
        }),
      ]);
      console.log(`  swept  ${sig}`);
      recovered += claim;
    }
  }

  // ---- 3. reported, never touched ---------------------------------------
  console.log("\nNOT recovered (deliberately):");
  for (const [name, id] of [["launchpad-curve", PROGRAM_ID], ["proposal-gate", GATE_ID]] as const) {
    const info = await connection.getAccountInfo(id);
    if (!info) continue;
    const programData = new PublicKey(info.data.subarray(4, 36));
    const pd = await connection.getAccountInfo(programData);
    const total = BigInt(info.lamports) + BigInt(pd?.lamports ?? 0);
    console.log(`  ${name}: ${SOL(total)} SOL of rent — recoverable ONLY by ` +
      `\`solana program close\`, which deletes the deployment every gate in ` +
      `GATES.md is evidence about. Human decision, not a flag.`);
  }
  console.log("  DAO treasuries: governance-owned. The only way out is a proposal");
  console.log("    through the gate — a voting window plus a hold-up to recover a");
  console.log("    fraction of a SOL. Left alone unless someone asks.");

  const after = await connection.getBalance(me);
  console.log(`\nbalance ${SOL(after)} SOL` +
    (APPLY ? `  (net ${SOL(after - before)} this run; gross recovered ${SOL(recovered)} before fees)` : ""));
  if (!APPLY) {
    console.log(`\nwould recover ${SOL(emptyRent)} SOL now` +
      `, or ${SOL(emptyRent + heldRent)} SOL with --burn, plus any vault sweeps above.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
