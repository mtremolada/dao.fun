/**
 * Browser-signing seam e2e (server-less, D-033): a fake wallet-standard
 * wallet is injected via the same registration handshake real wallets use.
 * The vote build/submit hits a live RPC (smoke-tested after deploy); here we
 * pin the wallet discovery + connect surface, which needs no chain. The
 * proposal override URL avoids any RPC read on load.
 */
import { expect, test } from "@playwright/test";

const PROPOSAL = "So11111111111111111111111111111111111111112";
const WALLET_ADDRESS = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
const OVERRIDE = `/proposal?id=${PROPOSAL}&chainHash=${"a".repeat(64)}&artifactHash=${"a".repeat(64)}&votingCompletedAt=1000&holdUpSeconds=0`;

test("connect a wallet-standard wallet and see the connected address", async ({
  page,
}) => {
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
            signTransaction: async (input: { transaction: Uint8Array }) => [
              { signedTransaction: input.transaction },
            ],
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", ((
        event: CustomEvent<{ register: (...ws: unknown[]) => void }>,
      ) => {
        event.detail.register(wallet);
      }) as EventListener);
    },
    { address: WALLET_ADDRESS },
  );

  await page.goto(OVERRIDE);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("wallet-address")).toContainText(WALLET_ADDRESS);
});

test("without a wallet installed, connect explains instead of crashing", async ({
  page,
}) => {
  await page.goto(OVERRIDE);
  await page.getByTestId("connect-wallet").click();
  await expect(page.getByTestId("connect-error")).toContainText("No wallet found");
});
