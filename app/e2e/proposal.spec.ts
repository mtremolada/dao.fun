/**
 * Spec 6.7 e2e (server-less, D-033): the proposal view's INV-9 hash badge and
 * the INV-3 execute button are recomputed CLIENT-SIDE from the shared
 * contract. Query params drive the override path (no RPC), so these assert
 * the trust surface deterministically without a chain.
 */
import { expect, test } from "@playwright/test";

const PROPOSAL = "So11111111111111111111111111111111111111112";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function proposalUrl(q: Record<string, string | number>): string {
  const params = new URLSearchParams({ id: PROPOSAL });
  for (const [k, v] of Object.entries(q)) params.set(k, String(v));
  return `/proposal?${params.toString()}`;
}

test("green 'verified against chain' badge when the recomputed and published hashes match", async ({
  page,
}) => {
  await page.goto(
    proposalUrl({
      artifactHash: HASH,
      chainHash: HASH,
      votingCompletedAt: 1000,
      holdUpSeconds: 0,
    }),
  );
  const badge = page.getByTestId("hash-badge");
  await expect(badge).toContainText(/verified against chain/i);
  await expect(badge).toHaveAttribute("data-state", "verified");
});

test("badge turns red on a recomputed/published mismatch", async ({ page }) => {
  await page.goto(
    proposalUrl({
      artifactHash: HASH,
      chainHash: OTHER_HASH,
      votingCompletedAt: 1000,
      holdUpSeconds: 0,
    }),
  );
  const badge = page.getByTestId("hash-badge");
  await expect(badge).toContainText(/mismatch/i);
  await expect(badge).toHaveAttribute("data-state", "mismatch");
});

test("no published hash shows the missing badge, not a crash", async ({
  page,
}) => {
  // chainHash present, artifactHash omitted -> nothing to verify against
  await page.goto(
    proposalUrl({ chainHash: OTHER_HASH, votingCompletedAt: 1000, holdUpSeconds: 0 }),
  );
  const badge = page.getByTestId("hash-badge");
  await expect(badge).toContainText(/no published hash/i);
  await expect(badge).toHaveAttribute("data-state", "missing");
});

test("execute button disabled with a countdown until the hold-up elapses; enabled after", async ({
  page,
}) => {
  const now = Math.floor(Date.now() / 1000);

  await page.goto(
    proposalUrl({
      artifactHash: HASH,
      chainHash: HASH,
      votingCompletedAt: now,
      holdUpSeconds: 3600,
    }),
  );
  await expect(page.getByTestId("execute-button")).toBeDisabled();
  await expect(page.getByTestId("holdup-countdown")).toContainText(/remaining/i);

  await page.goto(
    proposalUrl({
      artifactHash: HASH,
      chainHash: HASH,
      votingCompletedAt: now - 100,
      holdUpSeconds: 0,
    }),
  );
  await expect(page.getByTestId("execute-button")).toBeEnabled();
});
