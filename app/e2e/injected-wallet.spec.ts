/**
 * The INJECTED provider path (window.phantom.solana) — how Phantom and
 * Solflare actually connect, and the path the wallet-standard fake never
 * exercised. That gap let a real bug ship: those connections carry a bare
 * {address} account, so the wallet-standard signing adapter had nothing to
 * work with and every send failed "wallet cannot sign transactions".
 */
import { expect, test } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { configPda, curvePda, metadataPda } from "@daofun/sdk/launchpad";
import {
  CREATOR,
  METAPLEX,
  PROGRAM_ID,
  WALLET_ADDRESS,
  configAccountData,
  connectWallet,
  curveAccountData,
  installFakeWallet,
  installInjectedWallet,
  installRpcStub,
  metadataAccountData,
  midCurve,
  seedBrowser,
  coinAccounts,
} from "./launchpad-harness";

const MINT = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");

test("an injected-provider wallet can create a coin", async ({ page }) => {
  await seedBrowser(page);
  // Both are present in a real browser: the wallet registers with
  // wallet-standard AND injects its provider. The provider must win.
  await installFakeWallet(page);
  await installInjectedWallet(page);

  const accounts = new Map([
    [configPda(PROGRAM_ID).toBase58(), { data: configAccountData(CREATOR), owner: PROGRAM_ID }],
  ]);
  await installRpcStub(page, accounts, {
    onSendTransaction: (tx, register) => {
      const mint = tx.signatures
        .map((s) => s.publicKey.toBase58())
        .find((a) => a !== WALLET_ADDRESS);
      if (!mint) return;
      const mintKey = new PublicKey(mint);
      register(curvePda(mintKey, PROGRAM_ID).toBase58(), {
        data: curveAccountData({
          mint: mintKey,
          creator: new PublicKey(WALLET_ADDRESS),
          virtualSol: 30_000_000_000n,
          virtualToken: 1_073_000_000_000_000n,
          realSol: 0n,
          realToken: 793_100_000_000_000n,
        }),
        owner: PROGRAM_ID,
      });
      register(metadataPda(mintKey, METAPLEX).toBase58(), {
        data: metadataAccountData("Injected Coin", "INJ", "https://example.invalid/meta.json"),
        owner: METAPLEX,
      });
    },
  });

  await page.goto("/create");
  await connectWallet(page);
  await page.getByTestId("coin-name").fill("Injected Coin");
  await page.getByTestId("coin-symbol").fill("INJ");
  await page.getByTestId("launch-submit").click();

  await page.waitForURL(/\/coin\?mint=/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Injected Coin" })).toBeVisible();
});

test("an injected-provider wallet can trade", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await installInjectedWallet(page);
  await installRpcStub(page, coinAccounts(MINT, midCurve(MINT), { name: "Gate Coin", symbol: "GATE" }));
  await page.goto(`/coin?mint=${MINT.toBase58()}`);
  await connectWallet(page);

  await page.getByTestId("trade-amount").fill("0.5");
  await page.getByTestId("trade-submit").click();
  await expect(page.locator('[data-phase="done"]')).toBeVisible({ timeout: 15_000 });
});
