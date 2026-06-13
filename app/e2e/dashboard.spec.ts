/**
 * Spec 6.7 e2e (server-less, D-033): the dashboard reads the chain in the
 * browser, so its data flows are smoke-tested with a live RPC + funded wallet
 * after deploy. Here we assert the client-side guard that needs no RPC: the
 * page explains a missing required param instead of crashing.
 */
import { expect, test } from "@playwright/test";

const REALM = "GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR";

test("dashboard without ?vault= explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto(`/dao?realm=${REALM}`);
  await expect(page.getByTestId("dashboard-error")).toContainText(/vault/i);
});

test("dashboard without ?realm= explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto(`/dao`);
  await expect(page.getByTestId("dashboard-error")).toContainText(/realm/i);
});
