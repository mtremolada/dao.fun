/**
 * Spec 6.7 e2e (written before the implementation): the chain reader feeds
 * the proposal view server-side (no query params — hash, timestamps, and
 * veto status come from the /chain API), and the dashboard renders vault
 * balance, sweep history, and lockup-weighted vote power.
 */
import { expect, test } from "@playwright/test";

// Served by the fake ChainReader in e2e/stub-server.ts.
const CHAIN_PROPOSAL = "So11111111111111111111111111111111111111112";
const REALM = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";
const VAULT = "8Z4PfwCARrz3DbJQpwy9vhmYz3xvokn9tZN1vsHq1kj9";
const WALLET = "FnCV1QBqVWyup4dUzqkKbjzYqdpbx5neSqEX1DUAYDye";

test("proposal view is fully chain-fed: badge verifies against the recomputed hash, veto status shown", async ({
  page,
}) => {
  // No query params at all — everything must come from the chain reader.
  await page.goto(`/proposal/${CHAIN_PROPOSAL}`);

  const badge = page.getByTestId("hash-badge");
  await expect(badge).toContainText(/verified against chain/i);
  await expect(badge).toHaveAttribute("data-state", "verified");

  await expect(page.getByTestId("proposal-state")).toContainText("Completed");
  await expect(page.getByTestId("veto-status")).toContainText(/no veto/i);

  // holdUp 0 + voting completed in the past -> executable now (INV-3).
  await expect(page.getByTestId("execute-button")).toBeEnabled();
});

test("dashboard renders vault balance, sweep history, and vote power", async ({
  page,
}) => {
  await page.goto(`/dao/${REALM}?vault=${VAULT}&wallet=${WALLET}`);

  await expect(page.getByTestId("vault-balance")).toContainText("0.00089088");

  const sweeps = page.getByTestId("sweep-history");
  await expect(sweeps).toContainText("stub-sig-sweep-1");
  await expect(sweeps).toContainText("+0.00089088");
  await expect(sweeps).toContainText("stub-sig-exec-2");
  await expect(sweeps).toContainText("-0.00089088");

  await expect(page.getByTestId("vote-power")).toContainText("200000000000");
  await expect(page.getByTestId("vote-power")).toContainText(
    WALLET.slice(0, 8),
  );
});

test("dashboard without the required vault param explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto(`/dao/${REALM}`);
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);
});
