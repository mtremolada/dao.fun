/**
 * DAO dashboard (serverless): reads come from the visitor's RPC, so the e2e
 * asserts the input-guard path and the OFFLINE discovery path (both need no
 * network) — the missing realm/vault state explains itself, and given just a
 * mint the DAO's addresses are derived deterministically in the browser.
 */
import { PublicKey } from "@solana/web3.js";
import { expect, test } from "@playwright/test";

const REALM = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
const MINT = "So11111111111111111111111111111111111111112";
const VAULT = "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw";
const MS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Inline copy of deriveRealm(realmNameForMint(mint)) (pinned by the sdk pda
// tests) so the Playwright loader needs no TS-source import from the sdk.
const GOVERNANCE_PROGRAM = new PublicKey(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
);
function realmFromMint(mint: string): string {
  const name = new PublicKey(mint).toBase58().slice(0, 32);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), Buffer.from(name)],
    GOVERNANCE_PROGRAM,
  )[0].toBase58();
}

test("dashboard without the required params explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto("/dao");
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);

  await page.goto(`/dao?realm=${REALM}`);
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);
});

test("given only a mint, the DAO's realm is derived deterministically with no server", async ({
  page,
}) => {
  const expectedRealm = realmFromMint(MINT);

  // a bogus ?rpc= makes the proposal fetch fail fast; the derived addresses
  // render synchronously regardless — proving discovery needs no working server
  await page.goto(`/dao?mint=${MINT}&rpc=http://127.0.0.1:1`);
  await expect(page.getByTestId("dao-realm")).toHaveText(expectedRealm);
  await expect(page.getByTestId("dao-addresses")).toContainText(MINT);
});

test("the create-proposal form appears with treasury params and gates submit until filled", async ({
  page,
}) => {
  await page.goto(
    `/dao?mint=${MINT}&vault=${VAULT}&ms=${MS}&rpc=http://127.0.0.1:1`,
  );
  const form = page.getByTestId("create-proposal");
  await expect(form).toBeVisible();
  const submit = page.getByTestId("propose-submit");
  await expect(submit).toBeDisabled();

  await page.getByTestId("prop-recipient").fill(MS); // any valid pubkey
  await page.getByTestId("prop-amount").fill("0.5");
  await page.getByTestId("prop-name").fill("Pay a contributor");
  await expect(submit).toBeEnabled();
});
