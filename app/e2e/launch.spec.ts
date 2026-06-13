/**
 * Mode selection + launch form through the real UI (serverless). Covers:
 * guarded unselectable, sovereign double-confirm, sub-floor override
 * rejection, stricter-than-floor acceptance, and resolving the on-chain plan
 * client-side (no backend).
 */
import { expect, test } from "@playwright/test";

test("mode page compares modes side by side; guarded is unselectable", async ({
  page,
}) => {
  await page.goto("/");
  for (const mode of ["cypherpunk", "sovereign", "council"]) {
    const card = page.getByTestId(`mode-card-${mode}`);
    await expect(card).toBeVisible();
    await expect(card.getByRole("link", { name: /launch/i })).toBeVisible();
  }
  const guarded = page.getByTestId("mode-card-guarded");
  await expect(guarded).toBeVisible();
  await expect(guarded).toContainText(/stage 3/i);
  await expect(guarded.getByRole("link")).toHaveCount(0);
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

  // stricter than the floor is allowed
  await page.getByTestId("override-holdup").fill(String(100 * 3600));
  await expect(submit).toBeEnabled();

  await submit.click();
  const result = page.getByTestId("launch-result");
  await expect(result).toContainText(/cypherpunk/i);
  await expect(result).toContainText("holdUpSeconds");
  await expect(result).toContainText(String(100 * 3600));
});
