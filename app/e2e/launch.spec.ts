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
  // Guarded is unselectable until the proposal-gate program is deployed
  // on-chain (NEXT_PUBLIC_GUARDED_ENABLED unset in this build).
  const guarded = page.getByTestId("mode-card-guarded");
  await expect(guarded).toBeVisible();
  await expect(guarded).toContainText(/gate program/i);
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

test("hold-up slider is floored at the tier minimum (sub-floor is unreachable); stricter values resolve", async ({
  page,
}) => {
  await page.goto("/launch?mode=cypherpunk");
  const submit = page.getByTestId("launch-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("confirm-noVetoIrreversible").check();
  await expect(submit).toBeEnabled();

  // micro cypherpunk hold-up floor is 72h — the slider CANNOT go below it,
  // so a sub-floor value is structurally impossible (no error to reject).
  const holdup = page.getByTestId("override-holdup");
  await expect(holdup).toHaveAttribute("min", String(72 * 3600));
  // the resolved plan sits at the floor by default
  await expect(page.getByTestId("resolved-params")).toContainText(
    String(72 * 3600),
  );

  // dragging it stricter (longer) reflects in the resolved plan and stays valid
  await holdup.fill(String(100 * 3600));
  await expect(submit).toBeEnabled();
  await expect(page.getByTestId("resolved-params")).toContainText(
    String(100 * 3600),
  );
});
