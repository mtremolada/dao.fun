/**
 * The board (serverless) — now the FRONT page, with all three lifecycle
 * columns on screen at once. Without an indexer the board falls back to the
 * coins this browser has launched/visited, read straight from the (stubbed)
 * chain — so these specs prove the no-backend deploy actually shows coins,
 * buckets them into the right column, and links through to the coin page.
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

test("the front page IS the board: three columns side by side, devnet banner, create CTA", async ({
  page,
}) => {
  await seedBrowser(page);
  await page.goto("/");

  await expect(page.getByRole("note")).toContainText(/devnet/i);
  for (const column of ["new", "graduating", "graduated"]) {
    await expect(page.getByTestId(`column-${column}`)).toBeVisible();
  }
  // All three are visible AT ONCE — no tab needs clicking to reveal one.
  await expect(page.getByRole("heading", { name: "About to graduate" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Graduated" })).toBeVisible();
  await expect(page.getByRole("link", { name: /be the first to launch/i })).toBeVisible();
});

test("a locally-known coin renders from chain with live progress, and links to its page", async ({ page }) => {
  await seedBrowser(page, { coins: [MINT.toBase58()] });
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto("/");

  // 400e12 of 793.1e12 sold ≈ 50% — below the 80% tail, so it is NEW.
  const card = page.getByTestId("column-new").getByTestId("coin-GATE");
  await expect(card).toContainText("Gate Coin");
  await expect(card).toContainText("$GATE");
  await expect(card).toContainText("50%");

  await card.click();
  // First client navigation to /coin compiles the route on demand in next
  // dev — under parallel workers that can exceed the 5s expect default.
  await expect(page).toHaveURL(new RegExp(`/coin\\?mint=${MINT.toBase58()}`), { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Gate Coin" })).toBeVisible();
});

test("a graduated coin sits in the Graduated column only, with the badge", async ({ page }) => {
  await seedBrowser(page, { coins: [MINT.toBase58()] });
  await installRpcStub(
    page,
    coinAccounts(
      MINT,
      { ...midCurve(MINT), complete: true, migrated: true, poolState: POOL },
      { name: "Gate Coin", symbol: "GATE" },
    ),
  );
  await page.goto("/");

  const card = page.getByTestId("column-graduated").getByTestId("coin-GATE");
  await expect(card).toContainText("Graduated");
  // and it appears in exactly one column
  await expect(page.getByTestId("coin-GATE")).toHaveCount(1);
});

test("/board still resolves to the same board (old links keep working)", async ({ page }) => {
  await seedBrowser(page);
  await page.goto("/board");
  await expect(page.getByTestId("column-new")).toBeVisible();
});
