/**
 * Spec 6.7 e2e (written before the shell): proposal view renders the
 * artifact (decoded summary, simulation, red flags), the INV-9 hash badge
 * (red on simulated artifact/chain mismatch), and the INV-3 execute
 * button that stays disabled until the hold-up has elapsed.
 */
import { expect, test } from "@playwright/test";

// Seeded by e2e/stub-server.ts.
const PROPOSAL = "11111111111111111111111111111111";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function proposalUrl(q: Record<string, string | number>): string {
  const params = new URLSearchParams(
    Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])),
  );
  return `/proposal/${PROPOSAL}?${params.toString()}`;
}

test("artifact renders with a green 'verified against chain' badge when hashes match", async ({
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
  await expect(page.getByTestId("decoded-summary")).toContainText(
    "Transfer 0.00089088 SOL from the vault to the deployer",
  );
  await expect(page.getByTestId("simulation-result")).toContainText(/ok/i);
  await expect(page.getByTestId("red-flags")).toContainText(
    "drains the full vault balance",
  );
});

test("badge turns red on artifact/chain mismatch (simulated)", async ({
  page,
}) => {
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

test("missing artifact shows the missing badge, not a crash", async ({
  page,
}) => {
  await page.goto(
    proposalUrl({
      artifactHash: OTHER_HASH, // nothing stored under this hash
      chainHash: OTHER_HASH,
      votingCompletedAt: 1000,
      holdUpSeconds: 0,
    }),
  );
  const badge = page.getByTestId("hash-badge");
  await expect(badge).toContainText(/missing/i);
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
