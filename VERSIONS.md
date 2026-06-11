# VERSIONS.md — pinned dependency versions (Stage 0)

Pinned exactly in package.json files; lockfile (`pnpm-lock.yaml`) committed.

| Package | Version | Notes |
|---|---|---|
| node | >=22 (built with 22.22.2) | |
| pnpm | 10.33.0 | `packageManager` field |
| @pump-fun/pump-sdk | 1.36.0 | ESM build broken — CJS used (D-002) |
| @pump-fun/pump-swap-sdk | 1.17.0 | offline PumpAmmSdk — post-graduation venue (D-021) |
| @solana/spl-governance | 0.3.28 | |
| @sqds/multisig | 2.1.4 | |
| @solana/web3.js | 1.98.4 | v1.x required by the above SDKs |
| @solana/spl-token | 0.4.14 | |
| @coral-xyz/anchor | 0.30.1 | spec: Anchor 0.30+ pinned exact |
| bn.js | 5.2.2 | |
| typescript | ^5.6 (resolved 5.9.3) | |
| vitest | ^3.0 (resolved 3.2.6) | |
| solana-bankrun | 0.4.0 | GATE 1 matrix suite: real mainnet binaries + clock warp |
| next | ^15 (resolved 15.5.19) | app shell (13.7) |
| react / react-dom | ^19 (resolved 19.2.7) | |
| @playwright/test | ^1.60 (resolved 1.60.0) | e2e vs real backend handler |

Program IDs (verified against installed pump-sdk source — see DECISIONS.md):

| Program | ID |
|---|---|
| Pump bonding curve | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` |
| Pump AMM (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` |
| PumpFees | `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` |
| SPL Governance | `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw` |
| Voter Stake Registry | `vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ` |
| Squads v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Merkle distributor | UNRESOLVED — Stage 0 (verify) item still open |
