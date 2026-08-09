/**
 * Coin page + trade panel (serverless). The page reads the curve straight
 * from the (stubbed) chain; trades run the REAL send pipeline — preflight
 * cluster guard, blockhash, simulation, sign-only signing, dapp-side
 * broadcast, landing verification — against the harness RPC. This is the
 * devnet-broadcast-trap machinery under test through the actual UI.
 */
import { expect, test } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  FAKE_SIG,
  WALLET_ADDRESS,
  coinAccounts,
  connectWallet,
  installFakeWallet,
  installRpcStub,
  midCurve,
  seedBrowser,
  tokenAccountData,
} from "./launchpad-harness";

const MINT = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");
const POOL = new PublicKey("7Xi9ijr7mZS6YL1fmwfscSuEQyQ9kZD9W3PzbNob9Bof");
const URL = `/coin?mint=${MINT.toBase58()}`;

test("renders name, safety badges, progress and raised SOL from chain alone", async ({ page }) => {
  await seedBrowser(page);
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto(URL);

  await expect(page.getByRole("heading", { name: "Gate Coin" })).toBeVisible();
  await expect(page.getByText("$GATE")).toBeVisible();
  await expect(page.getByText("mint revoked")).toBeVisible();
  await expect(page.getByText("freeze: none")).toBeVisible();
  await expect(page.getByText(/50% to graduation/)).toContainText("raised 17.8306 SOL");
});

test("quotes update client-side for both sides; trading gated on a wallet", async ({ page }) => {
  await seedBrowser(page);
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto(URL);

  // buy quote: 1 SOL in → some GATE out, priced by the same math the program uses
  await page.getByTestId("trade-amount").fill("1");
  await expect(page.getByText(/You receive/)).toContainText("GATE");

  // sell quote: switch side, token amount in → SOL out
  await page.getByTestId("side-sell").click();
  await page.getByTestId("trade-amount").fill("1000");
  await expect(page.getByText(/You receive/)).toContainText("SOL");

  // no wallet connected → no trade button, a connect prompt instead
  await expect(page.getByTestId("trade-submit")).toHaveCount(0);
  await expect(page.getByText(/connect a wallet to trade/i)).toBeVisible();
});

test("a buy runs the full send pipeline to confirmed with a devnet explorer link", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto(URL);
  await connectWallet(page);

  await page.getByTestId("trade-amount").fill("0.5");
  await page.getByTestId("trade-submit").click();

  // sign-only path: the dapp broadcast to OUR rpc and verified the landing
  const status = page.locator('[data-phase="done"]');
  await expect(status).toContainText("Confirmed");
  const link = status.getByRole("link");
  await expect(link).toHaveAttribute("href", `https://explorer.solana.com/tx/${FAKE_SIG}?cluster=devnet`);
});

test("a wallet advertising only mainnet still trades on devnet (we broadcast, not it)", async ({ page }) => {
  // Regression: Phantom in Testnet Mode reports a chains list WITHOUT devnet
  // even while sitting on devnet, and the old preflight rejected every send
  // because of it. On the sign-only path the wallet never chooses the
  // network — our rpc and our blockhash do — so the trade must go through.
  await seedBrowser(page);
  await installFakeWallet(page, { chains: ["solana:mainnet"] });
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto(URL);
  await connectWallet(page);

  await page.getByTestId("trade-amount").fill("0.5");
  await page.getByTestId("trade-submit").click();

  await expect(page.locator('[data-phase="done"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-phase="error"]')).toHaveCount(0);
});

test("a graduated coin closes trading and links the Raydium pool", async ({ page }) => {
  await seedBrowser(page);
  await installRpcStub(
    page,
    coinAccounts(
      MINT,
      { ...midCurve(MINT), complete: true, migrated: true, poolState: POOL },
      { name: "Gate Coin", symbol: "GATE" },
    ),
  );
  await page.goto(URL);

  await expect(page.getByText(/trading closed/i)).toContainText("graduated to Raydium");
  await expect(page.getByText("LP burned")).toBeVisible();
  await expect(page.getByRole("link", { name: "Raydium pool" })).toHaveAttribute(
    "href",
    `https://explorer.solana.com/address/${POOL.toBase58()}?cluster=devnet`,
  );
  await expect(page.getByTestId("trade-amount")).toHaveCount(0);
});

test("an unknown mint fails soft with a clear error", async ({ page }) => {
  await seedBrowser(page);
  await installRpcStub(page, new Map());
  await page.goto(URL);
  await expect(page.getByText(/no curve found for this mint/i)).toBeVisible();
});

test("selling 100% asks for EXACTLY the balance, never a base unit more", async ({ page }) => {
  // Regression, reproduced from a live devnet wallet: holding
  // 533830845.549266 tokens, the old preset rendered toFixed(4) =
  // "533830845.5493" — 34 base units MORE than held — and the sell died in
  // the token program with an opaque InsufficientFunds.
  // Same 6-dp tail as the live wallet (…549266 -> toFixed(4) rounds UP to
  // …5493), sized so the curve's reserve can cover the sale.
  const HELD = 1_234_567_549_266n;
  await seedBrowser(page);
  await installFakeWallet(page);
  const accounts = coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" });
  const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(WALLET_ADDRESS), true);
  accounts.set(ata.toBase58(), {
    data: tokenAccountData(MINT, new PublicKey(WALLET_ADDRESS), HELD),
    owner: TOKEN_PROGRAM_ID,
  });
  await installRpcStub(page, accounts, { tokenBalances: new Map([[ata.toBase58(), HELD]]) });
  await page.goto(URL);
  await connectWallet(page);

  await page.getByTestId("side-sell").click();
  await page.getByTestId("preset-100pct").click();
  // Full precision, not a rounded-up 4dp string.
  await expect(page.getByTestId("trade-amount")).toHaveValue("1234567.549266");
  // And it is accepted: no over-balance warning, button live.
  await expect(page.getByTestId("over-balance")).toHaveCount(0);
  await expect(page.getByTestId("trade-submit")).toBeEnabled();
});

test("asking to sell more than you hold is refused before signing", async ({ page }) => {
  const HELD = 1_000_000n; // 1 token
  await seedBrowser(page);
  await installFakeWallet(page);
  const accounts = coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" });
  const ata = getAssociatedTokenAddressSync(MINT, new PublicKey(WALLET_ADDRESS), true);
  accounts.set(ata.toBase58(), {
    data: tokenAccountData(MINT, new PublicKey(WALLET_ADDRESS), HELD),
    owner: TOKEN_PROGRAM_ID,
  });
  await installRpcStub(page, accounts, { tokenBalances: new Map([[ata.toBase58(), HELD]]) });
  await page.goto(URL);
  await connectWallet(page);

  await page.getByTestId("side-sell").click();
  await page.getByTestId("trade-amount").fill("5");
  await expect(page.getByTestId("over-balance")).toContainText("You hold 1");
  await expect(page.getByTestId("trade-submit")).toBeDisabled();
});
