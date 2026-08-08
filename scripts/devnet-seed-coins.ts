/**
 * Devnet activity seeder — launches a handful of coins on the deployed
 * launchpad and trades them mid-curve from several wallets, so the public
 * board/terminal shows real charts, feeds, and top-traders instead of an
 * empty state. Useful after devnet resets too.
 *
 *   RPC_URL=<devnet rpc> PAYER_KEYPAIR=.wallets/deployer.json \
 *   npx tsx scripts/devnet-seed-coins.ts
 *
 * Defaults: public devnet RPC, the deployed program id, fee recipient read
 * from the on-chain config. Trades are paced ~20s apart so the 1-minute
 * candles span several buckets. Ephemeral trader wallets are funded from the
 * payer and swept back at the end — the only SOL left behind is what the
 * curves hold as raise progress (recoverable by selling) plus fees.
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildBuyIx,
  buildCreateCoinIx,
  buildSellIx,
  configPda,
  curvePda,
  decodeConfig,
  decodeCurve,
  buyQuote,
  sellQuote,
  tokensForSolInput,
  type CurveState,
} from "@daofun/sdk";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const PAYER_PATH = process.env.PAYER_KEYPAIR ?? ".wallets/deployer.json";
const PACE_MS = Number(process.env.PACE_MS ?? 20_000);
const META_BASE = "https://mtremolada.github.io/dao.fun/meta";

const loadKeypair = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]));
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(4);

async function sendRetry(
  connection: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label: string,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const tx = new Transaction().add(...ixs);
      const sig = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: "confirmed",
      });
      console.log(`  ${label}: ${sig}`);
      return sig;
    } catch (e) {
      lastErr = e;
      const wait = 2000 * 2 ** attempt;
      console.log(`  ${label}: attempt ${attempt + 1} failed (${(e as Error).message.slice(0, 120)}), retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

interface CoinPlan {
  name: string;
  symbol: string;
  uri: string;
  mint: Keypair;
}

async function curveState(connection: Connection, mint: PublicKey): Promise<CurveState> {
  const info = await connection.getAccountInfo(curvePda(mint, PROGRAM_ID));
  if (!info) throw new Error("curve missing");
  const c = decodeCurve(info.data);
  return {
    virtualSol: c.virtualSol,
    virtualToken: c.virtualToken,
    realSol: c.realSol,
    realToken: c.realToken,
    protocolFeeBps: c.protocolFeeBps,
    creatorFeeBps: c.creatorFeeBps,
    complete: c.complete,
  };
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(PAYER_PATH);
  console.log("payer:", payer.publicKey.toBase58(), "balance:", SOL(await connection.getBalance(payer.publicKey)), "SOL");

  const cfgInfo = await connection.getAccountInfo(configPda(PROGRAM_ID));
  if (!cfgInfo) throw new Error("launchpad config not initialized on this cluster");
  const feeRecipient = decodeConfig(cfgInfo.data).feeRecipient;

  // Distinct trader identities for the feed / top-traders tab; swept at exit.
  const traders = [Keypair.generate(), Keypair.generate()];
  await sendRetry(
    connection,
    [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: traders[0]!.publicKey, lamports: 1_000_000_000 }),
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: traders[1]!.publicKey, lamports: 800_000_000 }),
    ],
    [payer],
    "fund traders",
  );
  console.log("trader A:", traders[0]!.publicKey.toBase58());
  console.log("trader B:", traders[1]!.publicKey.toBase58());

  const coins: CoinPlan[] = [
    { name: "Fable", symbol: "FABLE", uri: `${META_BASE}/fable.json`, mint: Keypair.generate() },
    { name: "Gate Keeper", symbol: "GATE", uri: `${META_BASE}/gatekeeper.json`, mint: Keypair.generate() },
    { name: "Bankrun", symbol: "BANKRUN", uri: `${META_BASE}/bankrun.json`, mint: Keypair.generate() },
  ];

  for (const coin of coins) {
    console.log(`\ncreate ${coin.symbol} (${coin.mint.publicKey.toBase58()})`);
    await sendRetry(
      connection,
      [
        cu(300_000),
        buildCreateCoinIx({
          payer: payer.publicKey,
          mint: coin.mint.publicKey,
          creator: payer.publicKey,
          name: coin.name,
          symbol: coin.symbol,
          uri: coin.uri,
          programId: PROGRAM_ID,
        }),
      ],
      [payer, coin.mint],
      "create_coin",
    );
    await sleep(3_000);
  }

  async function buy(coin: CoinPlan, trader: Keypair, lamports: bigint): Promise<void> {
    const state = await curveState(connection, coin.mint.publicKey);
    const tokensOut = tokensForSolInput(state, lamports);
    if (tokensOut <= 0n) {
      console.log(`  skip buy ${coin.symbol}: budget too small`);
      return;
    }
    const quote = buyQuote(state, tokensOut);
    await sendRetry(
      connection,
      [
        cu(120_000),
        buildBuyIx({
          user: trader.publicKey,
          mint: coin.mint.publicKey,
          creator: payer.publicKey,
          feeRecipient,
          tokenAmount: tokensOut,
          maxSolCost: quote.totalCost + quote.totalCost / 50n, // 2% headroom
          programId: PROGRAM_ID,
        }),
      ],
      [trader],
      `buy ${coin.symbol} ${SOL(lamports)} SOL (${trader.publicKey.toBase58().slice(0, 4)}…)`,
    );
  }

  async function sellPct(coin: CoinPlan, trader: Keypair, pct: bigint): Promise<void> {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(coin.mint.publicKey, trader.publicKey, true);
    const info = await connection.getAccountInfo(ata);
    if (!info) {
      console.log(`  skip sell ${coin.symbol}: no holdings`);
      return;
    }
    const held = Buffer.from(info.data).readBigUInt64LE(64);
    const amount = (held * pct) / 100n;
    if (amount <= 0n) return;
    const state = await curveState(connection, coin.mint.publicKey);
    const quote = sellQuote(state, amount);
    await sendRetry(
      connection,
      [
        cu(120_000),
        buildSellIx({
          user: trader.publicKey,
          mint: coin.mint.publicKey,
          creator: payer.publicKey,
          feeRecipient,
          tokenAmount: amount,
          minSolOutput: quote.netSol - quote.netSol / 50n, // 2% slippage
          programId: PROGRAM_ID,
        }),
      ],
      [trader],
      `sell ${coin.symbol} ${pct}% (${trader.publicKey.toBase58().slice(0, 4)}…)`,
    );
  }

  const [fable, gate, bankrun] = coins as [CoinPlan, CoinPlan, CoinPlan];
  const [a, b] = traders as [Keypair, Keypair];
  // Interleaved and paced (~20s apart => several 1m candles per coin).
  const steps: (() => Promise<void>)[] = [
    () => buy(fable, a, 350_000_000n),
    () => buy(gate, payer, 300_000_000n),
    () => buy(bankrun, a, 150_000_000n),
    () => buy(fable, b, 200_000_000n),
    () => buy(gate, a, 250_000_000n),
    () => sellPct(fable, a, 40n),
    () => buy(bankrun, payer, 100_000_000n),
    () => buy(gate, b, 120_000_000n),
    () => buy(fable, payer, 80_000_000n),
    () => sellPct(gate, a, 30n),
    () => buy(bankrun, b, 180_000_000n),
    () => buy(fable, a, 120_000_000n),
    () => sellPct(bankrun, b, 50n),
    () => buy(gate, payer, 90_000_000n),
    () => buy(fable, b, 60_000_000n),
  ];
  for (const [i, step] of steps.entries()) {
    console.log(`\nstep ${i + 1}/${steps.length}`);
    try {
      await step();
    } catch (e) {
      console.log(`  step failed permanently, continuing: ${(e as Error).message.slice(0, 160)}`);
    }
    if (i < steps.length - 1) await sleep(PACE_MS);
  }

  // Sweep trader SOL home (token holdings stay — they're the positions).
  for (const t of traders) {
    const bal = await connection.getBalance(t.publicKey);
    if (bal > 10_000) {
      await sendRetry(
        connection,
        [SystemProgram.transfer({ fromPubkey: t.publicKey, toPubkey: payer.publicKey, lamports: bal - 5_000 })],
        [t],
        `sweep ${t.publicKey.toBase58().slice(0, 4)}…`,
      );
    }
  }

  console.log("\n=== summary ===");
  for (const coin of coins) {
    const state = await curveState(connection, coin.mint.publicKey);
    const pct = Number((state.realSol * 10_000n) / 2_834_000_000n) / 100;
    console.log(
      `${coin.symbol}  mint ${coin.mint.publicKey.toBase58()}  raised ${SOL(state.realSol)} SOL (~${pct.toFixed(1)}% of graduation)`,
    );
    console.log(`  https://mtremolada.github.io/dao.fun/coin?mint=${coin.mint.publicKey.toBase58()}`);
  }
  console.log("payer end balance:", SOL(await connection.getBalance(payer.publicKey)), "SOL");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
