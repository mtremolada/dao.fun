/**
 * Launchpad board (serverless). Without an indexer the board falls back to
 * the coins this browser has launched/visited, read straight from the (stubbed)
 * chain — so these specs prove the no-backend deploy actually shows coins,
 * filters the tabs, and links through to the coin page.
 */
import { expect, test } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import {
  coinAccounts,
  installRpcStub,
  midCurve,
  seedBrowser,
} from "./launchpad-harness";

const MINT = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");
const POOL = new PublicKey("7Xi9ijr7mZS6YL1fmwfscSuEQyQ9kZD9W3PzbNob9Bof");

test("empty board: tabs, devnet banner, backend note, and the launch CTA", async ({ page }) => {
  await seedBrowser(page);
  await page.goto("/board");

  await expect(page.getByRole("note")).toContainText(/devnet/i);
  for (const tab of ["new", "graduating", "graduated"]) {
    await expect(page.getByTestId(`tab-${tab}`)).toBeVisible();
  }
  // no backend configured → the board says so instead of silently showing nothing
  await expect(page.getByText(/needs the backend API/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /be the first to launch/i })).toBeVisible();
});

test("a locally-known coin renders from chain with live progress, and links to its page", async ({ page }) => {
  await seedBrowser(page, { coins: [MINT.toBase58()] });
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto("/board");

  const card = page.getByTestId("coin-GATE");
  await expect(card).toContainText("Gate Coin");
  await expect(card).toContainText("$GATE");
  // 400e12 of 793.1e12 sold ≈ 50%
  await expect(card).toContainText("50%");

  await card.click();
  await expect(page).toHaveURL(new RegExp(`/coin\\?mint=${MINT.toBase58()}`));
  await expect(page.getByRole("heading", { name: "Gate Coin" })).toBeVisible();
});

test("tabs filter: a graduated coin appears only under Graduated, with the badge", async ({ page }) => {
  await seedBrowser(page, { coins: [MINT.toBase58()] });
  await installRpcStub(
    page,
    coinAccounts(
      MINT,
      { ...midCurve(MINT), complete: true, migrated: true, poolState: POOL },
      { name: "Gate Coin", symbol: "GATE" },
    ),
  );
  await page.goto("/board");

  // migrated coins are excluded from New
  await expect(page.getByText(/no coins here yet/i)).toBeVisible();

  await page.getByTestId("tab-graduated").click();
  const card = page.getByTestId("coin-GATE");
  await expect(card).toContainText("Graduated");
});
