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
| bn.js | 5.2.3 | bumped from 5.2.2 (GATE 2 audit: infinite-loop advisory) |
| fast-check | 4.5.3 | Stage 2 property + fuzz suites |
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
| Merkle distributor (Jito, IMMUTABLE on mainnet) | `mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv` (D-024) |

## Launchpad (SPEC-LAUNCHPAD.md)

Rust/on-chain pins for `programs/launchpad-curve` (D-035):

| Item | Pin | Notes |
|---|---|---|
| solana-cli / cargo-build-sbf | 4.1.1 / 4.1.0 | drift from D-029's 4.0.0, accepted |
| platform-tools | v1.54 | curl-fetch into `~/.cache/solana/v1.54/platform-tools/` (proxy CA) |
| anchor-lang | 0.30.1 (`event-cpi`) | matches the workspace pin |
| anchor-spl | 0.30.1 (`metadata`) | re-exports mpl-token-metadata 4.1.2; do NOT pair with mpl 5.x |
| raydium-cpmm-cpi | git rev `31338e2504e4a23172bdbbb49e05b10566594b14` | anchor-0.30.1 branch, pinned by rev not branch |
| solana-security-txt | 1.1.1 | on-chain contact block |

Launchpad program IDs (graduation venue — verified against the DEPLOYED
binaries, D-034; fixture provenance in `tests/fixtures/fixture-slots.json`):

| Program / account | Mainnet | Devnet |
|---|---|---|
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` |
| CPMM AmmConfig index 0 (0.25%) | `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` | `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` |
| CPMM `create_pool_fee` receiver (wSOL) | `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8` | `3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy` |
| CPMM vault/LP-mint authority | `GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL` | same seed, same address |
| Metaplex Token Metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | same |
| Raydium liquidity lock ("Burn & Earn") | `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` | **NOT DEPLOYED** |
| Lock CPMM authority (`["lock_cp_authority_seed"]`) | `3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH` | — |
| `launchpad-curve` | minted at first devnet deploy (Phase 8) | — |

CPMM fixture deploy slot: **425,801,539** (2026-06-11). The program is
upgradeable — monitor the live ProgramData slot against this pin; an
unnoticed upgrade is how the spl-governance fork burned us (D-031).

Lock-program fixture deploy slot: **362,025,476** (2025-08-23), upgrade
authority `FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK` — also
upgradeable, also monitored (D-049). It hard-codes the MAINNET CPMM/CLMM
program ids and has no devnet deployment, so the graduated-fee lock branch
is mainnet-only by construction; devnet migrations keep burning the LP.

DEVNET TRAP: `raydium-cpi-example`'s README still advertises an older,
parallel devnet deployment (`CPMDWBwJ…` / `9zSzfkYy…` / `G11FKB…`). Pools
created there do not appear in Raydium's devnet UI. Use the `DRaycpLY…`
set above.
