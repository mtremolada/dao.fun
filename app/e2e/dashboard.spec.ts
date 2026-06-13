/**
 * DAO dashboard (serverless): reads come from the visitor's RPC, so the e2e
 * only asserts the input-guard path (which needs no network) — the missing
 * realm/vault state explains itself instead of crashing.
 */
import { expect, test } from "@playwright/test";

const REALM = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";

test("dashboard without the required params explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto("/dao");
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);

  await page.goto(`/dao?realm=${REALM}`);
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);
});
