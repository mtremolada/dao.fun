/**
 * Board bucketing — ONE rule for the three columns, shared by the backend's
 * SQL (packages/backend/src/launchpad/store.ts) and the app's chain-direct
 * fallback, so a coin can never appear in two columns or none.
 *
 * The buckets are disjoint and ordered by lifecycle: a migrated coin has
 * graduated; anything still on the curve that is either complete (awaiting
 * the permissionless migrate crank) or past the progress threshold is about
 * to graduate; everything else is new.
 */
export type BoardBucket = "new" | "graduating" | "graduated";

/** Default: the last 20% of the reserve is the "about to graduate" tail. */
export const GRADUATING_THRESHOLD_BPS = 8000;

export function boardBucket(
  coin: { progressBps: number; complete: boolean; migrated: boolean },
  thresholdBps: number = GRADUATING_THRESHOLD_BPS,
): BoardBucket {
  if (coin.migrated) return "graduated";
  if (coin.complete || coin.progressBps >= thresholdBps) return "graduating";
  return "new";
}
