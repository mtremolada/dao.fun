/**
 * Spec 6.7 e2e (server-less, D-033): mode selection + the launch form's
 * validation contract, rendered client-side from the SHARED launch-form
 * functions (the same ones the on-chain builders enforce). The actual
 * ceremony build/sign/submit runs against a live RPC + wallet and is
 * smoke-tested after deploy; here we pin the floors/confirmations surface.
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

test("sovereign requires BOTH confirmations before the form validates", async ({
  page,
}) => {
  await page.goto("/launch?mode=sovereign");
  await page.getByTestId("sovereign-holdup").fill("0");
  await expect(page.getByTestId("form-errors")).toContainText(
    /BOTH confirmations/i,
  );

  await page.getByTestId("confirm-noVeto").check();
  await expect(page.getByTestId("form-errors")).toContainText(
    /BOTH confirmations/i,
  );

  await page.getByTestId("confirm-canDrainImmediately").check();
  await expect(page.getByTestId("resolved-params")).toBeVisible();
});

test("sub-floor override rejected with the floor error; stricter accepted", async ({
  page,
}) => {
  await page.goto("/launch?mode=cypherpunk");
  await page.getByTestId("confirm-noVetoIrreversible").check();
  await expect(page.getByTestId("resolved-params")).toBeVisible();

  // micro hold-up floor is 72h; 1h must be rejected client-side
  await page.getByTestId("override-holdup").fill("3600");
  await expect(page.getByTestId("form-errors")).toContainText(
    /below the micro tier floor/,
  );

  // stricter than the floor is allowed
  await page.getByTestId("override-holdup").fill(String(100 * 3600));
  await expect(page.getByTestId("resolved-params")).toBeVisible();
});
