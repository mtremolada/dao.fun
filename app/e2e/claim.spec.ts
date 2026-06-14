/**
 * Enhanced-listing claim (serverless, D-037): the payer pastes the payment tx
 * hash AND signs the claim challenge with their wallet — submitting BOTH proofs
 * themselves. The fake wallet returns a REAL ed25519 signature over the exact
 * canonical challenge (precomputed here with node:crypto for a throwaway key),
 * so the app's local verification turns green honestly.
 *
 * The active signer is the injected provider (window.phantom.solana), which the
 * app prefers over wallet-standard — so signMessage lives there.
 */
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { expect, test } from "@playwright/test";

// Fixed claim parameters → a deterministic challenge we can pre-sign.
const MINT = Keypair.generate().publicKey.toBase58();
const CONTENT = "a".repeat(64);
const AMOUNT = "1500000000";
const TS = 1_800_000_000;
const TXSIG = "1".repeat(88);

const payer = Keypair.generate();
const ADDRESS = payer.publicKey.toBase58();

// EXACT copy of the sdk's buildClaimChallenge (pinned by the sdk unit tests) so
// the e2e needs no TS-source import in the Playwright loader.
const CHALLENGE = [
  "daofun: enhanced-listing reimbursement claim",
  `mint: ${MINT}`,
  `content: ${CONTENT}`,
  `reimburse-to: ${ADDRESS}`,
  `amount-lamports: ${AMOUNT}`,
  `payment-tx: ${TXSIG}`,
  `payment-ts: ${TS}`,
].join("\n");

function edSign(message: string, secretKey: Uint8Array): Buffer {
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(secretKey.slice(0, 32)),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return cryptoSign(null, Buffer.from(message, "utf8"), key);
}

const SIG_B64 = edSign(CHALLENGE, payer.secretKey).toString("base64");

const claimUrl = `/claim?mint=${MINT}&content=${CONTENT}&amount=${AMOUNT}&ts=${TS}`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ({ address, sigB64 }) => {
      const toBytes = (b64: string) =>
        Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const account = { address };
      const wallet = {
        version: "1.0.0",
        name: "Phantom",
        icon: "data:image/svg+xml;base64,",
        chains: ["solana:mainnet"],
        accounts: [],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async (input: { silent?: boolean }) => {
              void input.silent;
              return { accounts: [account] };
            },
          },
          "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signAndSendTransaction": {
            version: "1.0.0",
            signAndSendTransaction: async () => [
              { signature: new Uint8Array(64).fill(7) },
            ],
          },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async () => [
              { signedMessage: new Uint8Array(), signature: toBytes(sigB64) },
            ],
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", ((
        event: CustomEvent<{ register: (...ws: unknown[]) => void }>,
      ) => {
        event.detail.register(wallet);
      }) as EventListener);

      // The injected provider is what the app prefers; it must sign messages.
      (window as unknown as { phantom: unknown }).phantom = {
        solana: {
          isPhantom: true,
          publicKey: { toString: () => address },
          connect: async () => ({ publicKey: { toString: () => address } }),
          disconnect: async () => {},
          signAndSendTransaction: async () => ({ signature: "FAKE_SIG" }),
          signMessage: async () => ({ signature: toBytes(sigB64) }),
        },
      };
    },
    { address: ADDRESS, sigB64: SIG_B64 },
  );
});

async function connect(page: import("@playwright/test").Page) {
  await page.getByTestId("connect-wallet").click();
  await page.getByTestId("wallet-option-phantom").click();
  await expect(page.getByTestId("claim-wallet")).toContainText(ADDRESS);
}

test("payer submits both the wallet signature and the tx hash; claim verifies locally", async ({
  page,
}) => {
  await page.goto(claimUrl);
  await connect(page);

  // submit is gated until a payment tx hash is entered
  await expect(page.getByTestId("submit-claim")).toBeDisabled();
  await page.getByTestId("claim-txhash").fill(TXSIG);
  await expect(page.getByTestId("submit-claim")).toBeEnabled();

  await page.getByTestId("submit-claim").click();

  // the wallet signature over the bound challenge verifies (the payer controls
  // the paying wallet), and the assembled submission carries BOTH proofs.
  await expect(page.getByTestId("claim-verified")).toContainText(/verified/i);
  const submission = page.getByTestId("claim-submission");
  await expect(submission).toContainText(TXSIG); // the tx hash
  await expect(submission).toContainText(/signatureBase64/); // the wallet signature
  await expect(submission).toContainText(ADDRESS); // bound payer == signer
});

test("a claim page without parameters explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto("/claim");
  await expect(page.getByTestId("claim-error")).toContainText(/parameters/i);
});
