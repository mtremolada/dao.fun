/**
 * Terminal e2e — the /coin page as a trading terminal, hermetic.
 *
 * Two load-bearing paths the other specs don't cover:
 *  - a GRADUATED coin with its Raydium pool present: the panel flips to AMM
 *    mode and a buy runs the REAL send pipeline against fabricated pool
 *    bytes (the same layouts the bankrun suite proved against the deployed
 *    binary; the quote shown must equal the SDK math run here in the spec).
 *  - the no-backend terminal: trade history recovered from fabricated
 *    getSignaturesForAddress/getTransaction wire responses (batched RPC),
 *    feeding the trades tab, top-traders tab, stats strip, chart canvas,
 *    and the position card.
 */
import { expect, test } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { cpmmSwapBaseInputQuote } from "@daofun/sdk/launchpad";
import {
  WALLET_ADDRESS,
  coinAccounts,
  connectWallet,
  installFakeWallet,
  installRpcStub,
  midCurve,
  poolAccounts,
  seedBrowser,
  type StubTrade,
} from "./launchpad-harness";

const MINT = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");
const POOL = new PublicKey("7Xi9ijr7mZS6YL1fmwfscSuEQyQ9kZD9W3PzbNob9Bof");
const URL = `/coin?mint=${MINT.toBase58()}`;

const WSOL_RESERVE = 79_000_000_000n; // ~79 SOL
const COIN_RESERVE = 206_900_000_000_000n; // ~206.9M tokens

test("a graduated coin with a live pool trades on the AMM through the real pipeline", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  const accounts = coinAccounts(
    MINT,
    { ...midCurve(MINT), complete: true, migrated: true, poolState: POOL },
    { name: "Gate Coin", symbol: "GATE" },
  );
  for (const [k, v] of poolAccounts(MINT, POOL, { wsol: WSOL_RESERVE, coin: COIN_RESERVE })) {
    accounts.set(k, v);
  }
  await installRpcStub(page, accounts);
  await page.goto(URL);
  await connectWallet(page);

  // AMM mode announced, with the pool's fee.
  await expect(page.getByTestId("amm-note")).toContainText("Raydium pool (0.25% fee)");

  // The rendered quote must equal the SDK math for these reserves.
  await page.getByTestId("trade-amount").fill("0.5");
  const { amountOut } = cpmmSwapBaseInputQuote({
    amountIn: 500_000_000n,
    inputReserve: WSOL_RESERVE,
    outputReserve: COIN_RESERVE,
    tradeFeeRate: 2500n,
  });
  const formatted = (Number(amountOut) / 1e6).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
  await expect(page.locator(".quote")).toContainText(formatted);

  // And the swap goes through the real sign→broadcast→confirm pipeline.
  await page.getByTestId("trade-submit").click();
  await expect(page.locator('[data-phase="done"]')).toBeVisible({ timeout: 15_000 });
});

/** Two trades, newest first: a whale sell, then OUR wallet's earlier buy. */
function stubTrades(): StubTrade[] {
  const now = Math.floor(Date.now() / 1000) - 60;
  const whale = new PublicKey(Buffer.alloc(32, 5));
  return [
    {
      signature: bs58.encode(Buffer.alloc(64, 9)),
      slot: 120,
      blockTime: now,
      trader: whale,
      isBuy: false,
      tokenAmount: 1_000_000_000_000n,
      solAmount: 40_000_000_000n,
      virtualSol: 47_000_000_000n,
      virtualToken: 680_000_000_000_000n,
    },
    {
      signature: bs58.encode(Buffer.alloc(64, 8)),
      slot: 100,
      blockTime: now - 300,
      trader: new PublicKey(WALLET_ADDRESS),
      isBuy: true,
      tokenAmount: 5_000_000_000_000n,
      solAmount: 250_000_000n,
      virtualSol: 47_830_609_212n,
      virtualToken: 673_000_000_000_000n,
    },
  ];
}

test("the no-backend terminal reconstructs trades from chain and prices the position", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await installRpcStub(
    page,
    coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }),
    { trades: { mint: MINT, list: stubTrades() } },
  );
  await page.goto(URL);
  await connectWallet(page);

  // Trades tab: both directions decoded off the wire, newest first.
  const feed = page.getByTestId("trades-feed");
  await expect(feed.locator("tbody tr")).toHaveCount(2);
  await expect(feed.locator("tbody tr").first()).toContainText("Sell");
  await expect(feed.locator("tbody tr").last()).toContainText("Buy");

  // Stats strip prices off the curve; the chart canvas is live.
  await expect(page.getByTestId("stat-price")).toContainText("SOL");
  await expect(page.locator(".chart-wrap canvas").first()).toBeVisible();

  // Top traders: the whale and us, with the "you" badge on our row.
  await page.getByTestId("activity-traders").click();
  const traders = page.getByTestId("traders-table");
  await expect(traders.locator("tbody tr")).toHaveCount(2);
  await expect(traders.locator("tbody tr", { hasText: "you" })).toHaveCount(1);

  // Position card: our 5M-token buy at 0.25 SOL, still held.
  const position = page.getByTestId("position-card");
  await expect(position).toContainText("5,000,000 GATE");
  await expect(position).toContainText("Avg cost");
});
