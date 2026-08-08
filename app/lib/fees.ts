/**
 * Priority-fee estimator, behind a seam. On devnet fees are ~free, so a small
 * constant is right — but every transaction still carries a compute-budget
 * price instruction, so the pipeline shape is production-grade and pointing it
 * at Helius's getPriorityFeeEstimate for mainnet is a one-file change.
 */
export interface FeeEstimator {
  /** Micro-lamports per compute unit. */
  priorityFeeMicroLamports(): Promise<number>;
}

export class ConstantFeeEstimator implements FeeEstimator {
  constructor(private readonly microLamports = 10_000) {}
  async priorityFeeMicroLamports(): Promise<number> {
    return this.microLamports;
  }
}
