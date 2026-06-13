/**
 * Proposal view (serverless): the INV-3 execute button stays disabled with a
 * countdown until the hold-up elapses, then enables. Driven by query
 * overrides so the assertion needs no RPC.
 */
import { expect, test } from "@playwright/test";

const PROPOSAL = "So11111111111111111111111111111111111111112";

function proposalUrl(q: Record<string, string | number>): string {
  const params = new URLSearchParams({
    id: PROPOSAL,
    ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])),
  });
  return `/proposal?${params.toString()}`;
}

test("execute button disabled with a countdown until the hold-up elapses; enabled after", async ({
  page,
}) => {
  const now = Math.floor(Date.now() / 1000);

  await page.goto(proposalUrl({ votingCompletedAt: now, holdUpSeconds: 3600 }));
  await expect(page.getByTestId("execute-button")).toBeDisabled();
  await expect(page.getByTestId("holdup-countdown")).toContainText(/remaining/i);

  await page.goto(
    proposalUrl({ votingCompletedAt: now - 100, holdUpSeconds: 0 }),
  );
  await expect(page.getByTestId("execute-button")).toBeEnabled();
});

test("a proposal page without ?id= explains itself instead of crashing", async ({
  page,
}) => {
  await page.goto("/proposal");
  await expect(page.getByTestId("proposal-error")).toContainText(/id=/i);
});
