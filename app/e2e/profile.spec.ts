/**
 * Your Profile (serverless). The launches list is discovered the way the app
 * really does it — getProgramAccounts filtered by dataSize + a creator
 * memcmp — so this spec proves the FILTERS, not just the rendering: the stub
 * applies them exactly as a validator would, and the Config account (which
 * carries a pubkey at the same offset) must NOT be mistaken for a coin.
 */
import { expect, test } from "@playwright/test";
import { PublicKey } from "@solana/web3.js";
import { creatorVaultPda } from "@daofun/sdk/launchpad";
import {
  METAPLEX,
  PROGRAM_ID,
  WALLET_ADDRESS,
  configAccountData,
  connectWallet,
  curveAccountData,
  installFakeWallet,
  installRpcStub,
  metadataAccountData,
  seedBrowser,
  type StubAccount,
} from "./launchpad-harness";
import { curvePda, metadataPda } from "@daofun/sdk/launchpad";

const WALLET = new PublicKey(WALLET_ADDRESS);
const MINT_LIVE = new PublicKey("8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K");
const MINT_DONE = new PublicKey("7Xi9ijr7mZS6YL1fmwfscSuEQyQ9kZD9W3PzbNob9Bof");

/** Two coins created BY the connected wallet, plus the config decoy. */
function profileAccounts(): Map<string, StubAccount> {
  const m = new Map<string, StubAccount>();
  const add = (mint: PublicKey, name: string, symbol: string, complete: boolean) => {
    m.set(curvePda(mint, PROGRAM_ID).toBase58(), {
      data: curveAccountData({
        mint,
        creator: WALLET,
        virtualSol: 47_830_609_212n,
        virtualToken: 673_000_000_000_000n,
        realSol: 17_830_609_212n,
        realToken: complete ? 0n : 393_100_000_000_000n,
        complete,
      }),
      owner: PROGRAM_ID,
    });
    m.set(metadataPda(mint, METAPLEX).toBase58(), {
      data: metadataAccountData(name, symbol, "https://example.invalid/meta.json"),
      owner: METAPLEX,
    });
  };
  add(MINT_LIVE, "Live Coin", "LIVE", false);
  add(MINT_DONE, "Done Coin", "DONE", true);
  // The decoy: Config is owned by the program and holds the fee recipient at
  // the SAME offset the creator filter reads. Only the size filter excludes it.
  m.set(configPdaKey(), { data: configAccountData(WALLET), owner: PROGRAM_ID });
  return m;
}
function configPdaKey(): string {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0].toBase58();
}

test("profile without a wallet invites you to connect", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  await page.goto("/profile");
  await expect(page.getByTestId("profile-connect")).toBeVisible();
});

test("your launches, claimable creator fees, and the graduate crank", async ({ page }) => {
  await seedBrowser(page);
  await installFakeWallet(page);
  const vault = creatorVaultPda(WALLET, PROGRAM_ID);
  await installRpcStub(page, profileAccounts(), {
    balances: new Map([
      [WALLET_ADDRESS, 2_500_000_000],
      // 0.5 SOL parked; 890,880 lamports of it is the rent floor the program keeps.
      [vault.toBase58(), 500_000_000],
    ]),
  });
  await page.goto("/profile");
  await connectWallet(page);

  // Both launches listed — and the Config decoy is NOT among them.
  await expect(page.getByTestId("profile-launch-count")).toHaveText("2");
  await expect(page.getByTestId("launch-LIVE")).toContainText("Live Coin");
  await expect(page.getByTestId("launch-DONE")).toContainText("Ready to graduate");
  await expect(page.getByTestId("profile-balance")).toContainText("2.5 SOL");

  // Claimable is the vault MINUS the rent floor it must retain.
  await expect(page.getByTestId("claimable-fees")).toContainText("0.4991 SOL");
  await expect(page.getByTestId("claim-fees")).toBeEnabled();

  // The finished curve offers the crank; the live one does not.
  await expect(page.getByTestId("graduate-DONE")).toBeVisible();
  await expect(page.getByTestId("graduate-LIVE")).toHaveCount(0);

  // Claiming runs the real send pipeline end to end.
  await page.getByTestId("claim-fees").click();
  await expect(page.locator('[data-phase="done"]')).toBeVisible({ timeout: 15_000 });
});
