/**
 * Chain reader (spec 6.7) — MOVED to the SDK so the browser can recompute the
 * INV-9 hash, anomalies, and dashboard directly from chain (a decentralized app
 * trusts no backend's read claims). Re-exported here for the optional server
 * and to keep `@daofun/backend` consumers (http-api, e2e stub, tests) unchanged.
 */
export {
  RpcChainReader,
  hashWrappedInstructionSet,
  detectProposalAnomalies,
  vaultDelta,
  collectProposalTransactions,
  MAX_PROPOSAL_TXS,
} from "@daofun/sdk";
export type {
  ChainReader,
  ProposalChainState,
  DaoDashboard,
  SweepEntry,
  ProposalTxData,
  CollectedProposalTxs,
} from "@daofun/sdk";
