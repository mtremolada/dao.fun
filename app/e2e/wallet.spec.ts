/**
 * Universal wallet connect (serverless). A fake wallet-standard wallet is
 * injected BEFORE load (the same registration handshake real wallets use);
 * the user connects through the top-right modal, the connection persists
 * across reloads, and the absence of a wallet is handled gracefully. The
 * proposal page is opened with hold-up overrides so no RPC is touched.
 */
import { expect, test } from "@playwright/test";

const PROPOSAL = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
// overrides drive the hold-up gate and bypass any chain read
const URL = `/proposal?id=${PROPOSAL}&votingCompletedAt=0&holdUpSeconds=0`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ address }) => {
      const account = { address };
      const wallet = {
        version: "1.0.0",
        // an allowlisted name so it surfaces in the supported-wallet list
        name: "Phantom",
        icon: "data:image/svg+xml;base64,",
        chains: ["solana:mainnet"],
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            // Faithful to real wallets: reads input.silent (no default), so a
            // caller passing `undefined` would throw — guards that regression.
            connect: async (input: { silent?: boolean }) => {
              void input.silent;
              return { accounts: [account] };
            },
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {},
          },
          "standard:events": {
            version: "1.0.0",
            on: () => () => {},
          },
          "solana:signAndSendTransaction": {
            version: "1.0.0",
            signAndSendTransaction: async () => [
              { signature: new Uint8Array(64).fill(7) },
            ],
          },
        },
      };
      // wallet-standard registration handshake (what real wallets do)
      window.addEventListener("wallet-standard:app-ready", ((
        event: CustomEvent<{ register: (...ws: unknown[]) => void }>,
      ) => {
        event.detail.register(wallet);
      }) as EventListener);

      // Real Phantom ALSO exposes an injected provider; the app prefers it.
      (window as unknown as { phantom: unknown }).phantom = {
        solana: {
          isPhantom: true,
          publicKey: { toString: () => address },
          connect: async () => ({ publicKey: { toString: () => address } }),
          disconnect: async () => {},
          signAndSendTransaction: async () => ({ signature: "FAKE_SIG" }),
        },
      };
    },
    { address: WALLET_ADDRESS },
  );
});

test("connect via the universal top-right modal; popup closes, header shows connected, vote unlocks", async ({
  page,
}) => {
  await page.goto(URL);

  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-modal")).toBeVisible();
  await page.getByTestId("wallet-option-phantom").click();

  // the popup goes away once connected
  await expect(page.getByTestId("wallet-modal")).toHaveCount(0);
  // the connect button is replaced by the connected pill (truncated)
  await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
  await expect(page.getByTestId("wallet-button-address")).toContainText("GRdk");
  // and the vote panel shows the full key + enabled actions
  await expect(page.getByTestId("wallet-address")).toContainText(
    WALLET_ADDRESS,
  );
  await expect(page.getByTestId("vote-approve")).toBeEnabled();
});

test("disconnecting returns to the connect state", async ({ page }) => {
  await page.goto(URL);
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-phantom").click();
  await expect(page.getByTestId("wallet-button-address")).toBeVisible();

  // open the connected dropdown and disconnect
  await page.getByTestId("wallet-button").click();
  await page.getByTestId("disconnect-wallet").click();

  // back to disconnected: connect button returns, the connected pill is gone,
  // and it does NOT silently reconnect on the next load
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
  await expect(page.getByTestId("wallet-button-address")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("connect-wallet")).toBeVisible();
});

test("the connection persists across a reload (stays connected)", async ({
  page,
}) => {
  await page.goto(URL);
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-phantom").click();
  await expect(page.getByTestId("wallet-button-address")).toBeVisible();

  await page.reload();

  // no reconnect click: the last wallet is restored silently on load
  await expect(page.getByTestId("wallet-button-address")).toContainText("GRdk");
  await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
});

test("with no wallet installed, the modal lists install options instead of crashing", async ({
  browser,
}) => {
  // a fresh context WITHOUT the init script: no wallet registered
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:3210${URL}`);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("no-wallets")).toContainText(/no .*wallet/i);
  await expect(page.getByTestId("wallet-install-phantom")).toBeVisible();
  await context.close();
});
