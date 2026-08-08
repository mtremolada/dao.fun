/**
 * Launch-a-coin flow (serverless). The full-flow spec is genuinely end to
 * end on the client: the browser generates the mint keypair, co-signs, the
 * pipeline broadcasts to the harness RPC — which extracts the mint from the
 * wire bytes and materializes its curve + metadata — and the app lands on
 * the new coin's page showing the name that was typed.
 */
import { expect, test } from "@playwright/test";
import {
  METAPLEX,
  PROGRAM_ID,
  WALLET_ADDRESS,
  connectWallet,
  curveAccountData,
  installFakeWallet,
  installRpcStub,
  metadataAccountData,
  configAccountData,
  seedBrowser,
  CREATOR,
} from "./launchpad-harness";
import { PublicKey } from "@solana/web3.js";
import { configPda, curvePda, metadataPda } from "@daofun/sdk/launchpad";

test("without a wallet the form routes to connect instead of failing", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await page.goto("/create");

  const submit = page.getByTestId("launch-submit");
  await expect(submit).toHaveText("Connect wallet");
  await submit.click();
  await expect(page.getByTestId("wallet-modal")).toBeVisible();
  await expect(page.getByTestId("wallet-option-solflare")).toBeVisible();
});

test("name and ticker are required before anything is signed", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await installRpcStub(page, new Map());
  await page.goto("/create");
  await connectWallet(page);

  await page.getByTestId("launch-submit").click();
  await expect(page.getByText("Name and ticker are required.")).toBeVisible();
});

test("launching a coin lands on its page, and the board remembers it", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);

  const accounts = new Map([
    [configPda(PROGRAM_ID).toBase58(), { data: configAccountData(CREATOR), owner: PROGRAM_ID }],
  ]);
  await installRpcStub(page, accounts, {
    // The browser just generated the mint; pull it off the wire and put the
    // coin "on chain" so the post-launch redirect has something to read.
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
        data: metadataAccountData("E2E Coin", "E2E", "https://example.invalid/meta.json"),
        owner: METAPLEX,
      });
    },
  });

  await page.goto("/create");
  await connectWallet(page);

  await page.getByTestId("coin-name").fill("E2E Coin");
  await page.getByTestId("coin-symbol").fill("e2e"); // uppercased by the form
  await expect(page.getByTestId("coin-symbol")).toHaveValue("E2E");
  await page.getByTestId("launch-submit").click();

  // confirmed → redirect to the fresh coin's page, rendered from chain
  await page.waitForURL(/\/coin\?mint=/);
  await expect(page.getByRole("heading", { name: "E2E Coin" })).toBeVisible();
  await expect(page.getByText("$E2E")).toBeVisible();
  await expect(page.getByText(/0% to graduation/)).toBeVisible();

  // rememberCoin: the local board now lists the launch
  await page.goto("/board");
  await expect(page.getByTestId("coin-E2E")).toContainText("E2E Coin");
});
