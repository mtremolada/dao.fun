/**
 * The ONE launch page through the real UI (serverless). Covers: all four
 * protections selectable on a single page with Guarded as the zero-config
 * default, sovereign double-confirm, sub-floor override rejection,
 * stricter-than-floor acceptance, and resolving the on-chain plan
 * client-side (no backend).
 */
import { expect, test } from "@playwright/test";

test("one launch page: all four protections selectable, guarded is the default", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("cta-launch")).toBeVisible();
  await page.getByTestId("cta-launch").click();
  await expect(page).toHaveURL(/\/launch/, { timeout: 30_000 });

  // Guarded selected by default, zero-config, with the menu explained.
  await expect(page.getByTestId("protection-guarded")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("guarded-note")).toContainText(/safety menu/i);
  await expect(page.getByTestId("council-members")).toHaveCount(0);

  // Every other protection is one click away on the SAME page.
  await page.getByTestId("protection-council").click();
  await expect(page.getByTestId("council-members")).toBeVisible();
  await page.getByTestId("protection-sovereign").click();
  await expect(page.getByTestId("sovereign-holdup")).toBeVisible();
  await page.getByTestId("protection-cypherpunk").click();
  await expect(page.getByTestId("confirm-noVetoIrreversible")).toBeVisible();
});

test("sovereign requires BOTH confirmations before launch enables", async ({
  page,
}) => {
  await page.goto("/launch?mode=sovereign");
  const submit = page.getByTestId("launch-submit");
  await page.getByTestId("sovereign-holdup").fill("0");
  await expect(submit).toBeDisabled();

  await page.getByTestId("confirm-noVeto").check();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("form-errors")).toContainText(
    /BOTH confirmations/i,
  );

  await page.getByTestId("confirm-canDrainImmediately").check();
  await expect(submit).toBeEnabled();
});

test("sub-floor override rejected with the floor error; stricter accepted; plan resolves", async ({
  page,
}) => {
  await page.goto("/launch?mode=cypherpunk");
  const submit = page.getByTestId("launch-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("confirm-noVetoIrreversible").check();
  await expect(submit).toBeEnabled();

  // micro hold-up floor is 72h; 1h must be rejected client-side
  await page.getByTestId("override-holdup").fill("3600");
  await expect(page.getByTestId("form-errors")).toContainText(
    /below the micro tier floor/,
  );
  await expect(submit).toBeDisabled();

  // stricter than the floor is allowed, and the resolved plan reflects it
  await page.getByTestId("override-holdup").fill(String(100 * 3600));
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId("resolved-params")).toContainText(
    String(100 * 3600),
  );
});
