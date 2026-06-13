/**
 * Browser-signing seam e2e (D-028): a fake wallet-standard wallet is
 * injected BEFORE the page loads (the same registration handshake real
 * wallets use); the user connects and votes; the signed BYTES round-trip
 * app -> wallet -> app is verified by the stub server, which only issues
 * the fake signature when the payload it receives is the unsigned tx the
 * builder produced, "signed" by the wallet.
 */
import { expect, test } from "@playwright/test";

// the chain-fed proposal the stub server knows
const PROPOSAL = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ address }) => {
      const account = { address };
      const wallet = {
        version: "1.0.0",
        name: "E2E Fake Wallet",
        icon: "data:image/svg+xml;base64,",
        chains: ["solana:mainnet"],
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => ({ accounts: [account] }),
          },
          "solana:signTransaction": {
            version: "1.0.0",
            signTransaction: async (input: { transaction: Uint8Array }) => {
              const prefix = new TextEncoder().encode("SIGNED:");
              const signed = new Uint8Array(
                prefix.length + input.transaction.length,
              );
              signed.set(prefix, 0);
              signed.set(input.transaction, prefix.length);
              return [{ signedTransaction: signed }];
            },
          },
        },
      };
      // wallet-standard registration handshake (what real wallets do)
      window.addEventListener("wallet-standard:app-ready", ((
        event: CustomEvent<{ register: (...ws: unknown[]) => void }>,
      ) => {
        event.detail.register(wallet);
      }) as EventListener);
    },
    { address: WALLET_ADDRESS },
  );
});

test("connect via the universal top-right modal and vote yes; the signed bytes round-trip", async ({
  page,
}) => {
  await page.goto(`/proposal/${PROPOSAL}`);

  // The persistent top-right control opens the provider modal; the detected
  // wallet is selected from the list (just like any dapp connect popup).
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-modal")).toBeVisible();
  await page.getByTestId("wallet-option-e2e-fake-wallet").click();

  // Header reflects the connection (truncated), the vote panel the full key.
  await expect(page.getByTestId("wallet-button-address")).toBeVisible();
  await expect(page.getByTestId("wallet-address")).toContainText(
    WALLET_ADDRESS,
  );

  await page.getByTestId("vote-approve").click();
  await expect(page.getByTestId("vote-status")).toHaveAttribute(
    "data-phase",
    "done",
  );
  // the stub only issues this when it received SIGNED:UNSIGNED-VOTE-TX:...
  await expect(page.getByTestId("vote-signature")).toContainText(
    "E2E-FAKE-SIGNATURE",
  );
});

test("the connection persists across a reload (stays connected)", async ({
  page,
}) => {
  await page.goto(`/proposal/${PROPOSAL}`);
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-e2e-fake-wallet").click();
  await expect(page.getByTestId("wallet-button-address")).toBeVisible();

  await page.reload();

  // No reconnect click: the last wallet is restored silently on load.
  await expect(page.getByTestId("wallet-button-address")).toContainText("GRdk");
  await expect(page.getByTestId("connect-wallet")).toHaveCount(0);
});

test("with no wallet installed, the modal lists install options instead of crashing", async ({
  browser,
}) => {
  // a fresh context WITHOUT the init script: no wallet registered
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:3210/proposal/${PROPOSAL}`);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("no-wallets")).toContainText(/no .*wallet/i);
  // and a way forward: at least one curated install link is offered.
  await expect(page.getByTestId("wallet-install-phantom")).toBeVisible();
  await context.close();
});
