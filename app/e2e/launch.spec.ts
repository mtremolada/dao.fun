/**
 * The DAO half of the ONE create page (serverless). /launch is gone as a
 * separate funnel — a DAO token is a toggle here — so these specs cover the
 * toggle revealing the options, the zero-config Guarded default, the
 * confirmations Sovereign demands, and floors rejecting sub-floor overrides.
 */
import { expect, test } from "@playwright/test";

test("the create page toggles to a DAO token and reveals the options", async ({ page }) => {
  await page.goto("/create");

  // Simple by default: no governance options on screen at all.
  await expect(page.getByTestId("kind-simple")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("dao-options")).toHaveCount(0);

  await page.getByTestId("kind-dao").click();
  await expect(page.getByTestId("dao-options")).toBeVisible();

  // Guarded is the default and needs nothing filled in.
  await expect(page.getByTestId("protection-guarded")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("protection-detail")).toContainText(/cannot be created at all/i);
  await expect(page.getByTestId("launch-submit")).toBeEnabled();
  await expect(page.getByTestId("council-members")).toHaveCount(0);

  // Every other level is one click away on the SAME page.
  await page.getByTestId("protection-council").click();
  await expect(page.getByTestId("council-members")).toBeVisible();
  await page.getByTestId("protection-cypherpunk").click();
  await expect(page.getByTestId("confirm-noVetoIrreversible")).toBeVisible();
});

test("/launch redirects into the create page", async ({ page }) => {
  await page.goto("/launch");
  await expect(page).toHaveURL(/\/create/, { timeout: 30_000 });
  await expect(page.getByTestId("kind-dao")).toBeVisible();
});

test("sovereign requires BOTH confirmations before the button enables", async ({ page }) => {
  await page.goto("/create");
  await page.getByTestId("kind-dao").click();
  await page.getByTestId("protection-sovereign").click();
  await page.getByTestId("sovereign-holdup").fill("0");

  const submit = page.getByTestId("launch-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("confirm-noVeto").check();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("form-errors")).toContainText(/BOTH confirmations/i);

  await page.getByTestId("confirm-canDrainImmediately").check();
  await expect(submit).toBeEnabled();
});

test("sub-floor override rejected with the floor error; stricter accepted", async ({ page }) => {
  await page.goto("/create");
  await page.getByTestId("kind-dao").click();
  await page.getByTestId("protection-cypherpunk").click();
  await page.getByTestId("confirm-noVetoIrreversible").check();
  const submit = page.getByTestId("launch-submit");
  await expect(submit).toBeEnabled();

  await page.getByTestId("toggle-advanced").click();
  // micro hold-up floor is 72h; 1h must be rejected client-side
  await page.getByTestId("override-holdup").fill("3600");
  await expect(page.getByTestId("form-errors")).toContainText(/below the micro tier floor/);
  await expect(submit).toBeDisabled();

  // stricter than the floor is allowed, and the resolved plan reflects it
  await page.getByTestId("override-holdup").fill(String(100 * 3600));
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId("resolved-params")).toContainText("100 h");
});
