import { PublicKey } from "@solana/web3.js";

// Program IDs per spec Section 1. Pump programs are deployed at the same
// address on devnet and mainnet.
export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
);
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
);
export const PUMP_FEES_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
);
export const SPL_GOVERNANCE_PROGRAM_ID = new PublicKey(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
);
export const VSR_PROGRAM_ID = new PublicKey(
  "vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ",
);
export const SQUADS_V4_PROGRAM_ID = new PublicKey(
  "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
);
// Jito merkle distributor (JTO airdrop deployment, Dec 2023). Resolved and
// verified on mainnet (D-024): executable, upgrade authority REMOVED
// (immutable), publishes its anchor IDL on chain (merkle_distributor 0.0.1,
// vendored at src/idl/merkle-distributor.json). The repo's declare_id
// (m1uq...) was never deployed to mainnet — this is the live one.
export const MERKLE_DISTRIBUTOR_PROGRAM_ID = new PublicKey(
  "mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv",
);
// proposal-gate (ours, Stage 3 — spec 6.9). Matches programs/proposal-gate
// declare_id; the production id is regenerated at first devnet deploy
// (D-029 key-handling rules).
export const GATE_PROGRAM_ID = new PublicKey(
  "3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg",
);
