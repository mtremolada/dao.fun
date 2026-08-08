# Raydium CPMM Devnet Story — verified 2026-08-08

All on-chain claims below were verified live on 2026-08-08 against `https://api.devnet.solana.com` / `https://api.mainnet-beta.solana.com` (getProgramAccounts / getAccountInfo / getTransaction / getBlockTime). Explorer URLs are given for human re-verification.

## 1. Devnet AmmConfig accounts (program `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb`)

Enumerated on-chain via gPA with `dataSize: 236` (AmmConfig::LEN = 8+1+1+2+4*8+32*2+8+8*15 = 236) and cross-checked against the working devnet API endpoint **`https://api-v3-devnet.raydium.io/main/cpmm-config`** (verified live, returns indexes 0–6). **8 configs exist on devnet; ALL have `disable_create_pool = false` and ALL have `create_pool_fee = 150,000,000 lamports (0.15 SOL) — identical to mainnet.**

| index | address | trade_fee_rate | create_pool_fee (lamports) | creator_fee_rate | disable_create_pool | in api-v3-devnet? |
|---|---|---|---|---|---|---|
| 0 | `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` | 2500 (0.25%) | 150000000 | 2500 | false | yes (showWithUI true) |
| 1 | `HTVWgp8CbUsRNmRE1p9RBYqopxe2qiyApSkiTFLrfxaW` | 3000 | 150000000 | 2500 | false | yes |
| 2 | `A9qBhPy4k5UYW72hSgAkh1Epr2do69P54yzzcMV3yv6b` | 5000 | 150000000 | 2500 | false | yes |
| 3 | `EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz` | 10000 (1%) | 150000000 | 2500 | false | yes |
| 4 | `5Gt9qrPJ6FVe9VHtwF2W2JrFR6p9jmx4DxBkgfPdaApk` | 40000 (4%) | 150000000 | 2500 | false | yes |
| 5 | `G7YfJJp1TX1VtzN4V2yhPNSU23AKPSy1U2miRdwAByK5` | 5000 | 150000000 | 4000 | false | yes (showWithUI false) |
| 6 | `8Pg5wr9H5i2GKbiH8315UiM1W9LJQT2tNiuqBeaoGKjz` | 50 | 150000000 | 14950 | false | yes (showWithUI false) |
| 7 | `88hjD9xpbXJn54PGHc2Xzx5GmFSp3tLfs9GdtsTAp8Em` | 3500 | 150000000 | 6500 | false | **NO — on-chain only** |

API-reported `protocolFeeRate = 120000`, `fundFeeRate = 40000` for indexes 0–6 (same as mainnet). Indexes 0–6 have protocol_owner/fund_owner = `DRay33UmULQCeawH3dVpJfN3uqLj6Qtq4ymSRx2pAgGK`; index 7's owners are the devnet admin `DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak` (looks like an admin test config — avoid). AmmConfig PDA seeds: `["amm_config", u16 index big-endian]`.

**Devnet create-pool-fee receiver `3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy` verified on-chain: it is a WSOL (So1111…1112) SPL token account (owner authority `DRayEuvQMUDHNsHLzNhzQsKnhCPPpbFqrau8L54XqGyW`) holding 1,568.98 WSOL** — i.e. ~10,460 historical pool creations at 0.15 SOL. It received 10 successful txs in the 7 hours before this check (latest 2026-08-08T00:24:46Z).

**TRAP — stale cpi-example README accounts:** the `raydium-io/raydium-cpi-example` README lists "CPMM devnet" Program `CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW`, AmmConfig `9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6`, FeeReceiver `G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2`. Verified on-chain: `9zSzfkYy…` is owned by the OLD `CPMDW…` program (a separate, still-live Raydium devnet deployment, last upgraded 2025-06-26). Open issue #16 (2025-08-18) documents that pools created on `CPMD…` do NOT show on the Raydium devnet UI, which uses `DRaycpLY…`. The devnet id in raydium-cp-swap source was switched to `DRaycpLY…` in commit `0011e63` "Style: update devnet ids" (2025-07-25); the example README was never updated. **Use the DRaycpLY… configs above, not the README's.**

## 2. Devnet vs mainnet version parity (upgradeable-loader ProgramData slots, RPC-verified)

- **Devnet CPMM `DRaycpLY18…`**: last upgraded slot 430784616 = **2025-12-26T04:06:31Z**; upgrade authority `DRayw6sn9fCvbhx5ZLtAVGAgAk6qAAX7UT7urzkXTeM5`; ProgramData `3KvTa2fYhMxMZNfHho5oX34yLQLwRauoU2JScBkugvXF`.
- **Mainnet CPMM `CPMMoo8L…`**: last upgraded slot 425801539 = **2026-06-11T16:39:55Z**; upgrade authority `FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK`.
- **Devnet LAGS mainnet by ~5.5 months.** The 2026-06-11 mainnet upgrade corresponds to PR #71 "Feat: support associated mint" (merged 2026-06-12): adds `create_support_mint_associated` / `close_support_mint_associated` instructions + `SupportMintAssociated` state, and modifies the Token-2022 mint-support check in `initialize` / `initialize_with_permission`. **Devnet almost certainly lacks these.** For plain SPL-Token mints (the launchpad graduation case) the `initialize` account/arg interface is unchanged by #71, so graduation flow is unaffected — but per your doctrine, verify against the deployed devnet binary.
- **Devnet DOES have the creator-fee-era interface**: its binary (2025-12-26) postdates creator-fee PR #55 (2025-08-18) and audit-fix #59 (2025-11-04); on-chain devnet AmmConfigs carry nonzero `creator_fee_rate` at offset 108, and a permissionless creator-fee-era `Initialize` succeeded today (see §4). So devnet = creator-fee era + audit fix, minus the June-2026 associated-mint feature.

## 3. What the `devnet` cargo feature changes (verbatim from `programs/cp-swap/src/lib.rs`, master)

```rust
#[cfg(feature = "devnet")]
declare_id!("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
#[cfg(not(feature = "devnet"))]
declare_id!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

pub mod admin {
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ");
}

pub mod create_pool_fee_reveiver {   // (sic — typo "reveiver" is in the source)
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
}
```

Exactly three constants switch: program ID, admin ID, create-pool-fee receiver. The cpi-example's `cpmm-cpi` Cargo.toml simply forwards the feature: `devnet = ["raydium-cp-swap/devnet"]`, and depends on `raydium-cp-swap = { git = …, features = ["no-entrypoint", "cpi"] }` — i.e. the official CPI crate IS raydium-cp-swap itself; no official standalone `raydium-cpmm-cpi` crate was found (crates.io lookup returned nothing; only a third-party `kirarisk/pinocchio-raydium-cpmm-cpi` wrapper exists). Build for devnet with `anchor build -- --features devnet` (per cpi-example README).

## 4. Practicalities of devnet pool creation (2026-08)

**Permissionless `initialize` WORKS on devnet TODAY.** Verified tx `2Chmb9KjEMMRemQfsMsJT3ZxqLVPm3wV91SQJT34YtvNLeZpFACMcb3yt2ffpCUbSfxcJJcdMv7qUJLJWvXK3ao7` (2026-08-08T00:24:46Z, no error) logs `Program DRaycpLY18… invoke [1] / Program log: Instruction: Initialize / … success`; the fee-receiver saw 10 successful txs in ~7h and the CPMM program itself had successful txs within minutes of the check.

**All-in cost of one pool creation (devnet rent minimums fetched via `getMinimumBalanceForRentExemption`):**
- createPoolFee: 150,000,000
- PoolState (637 B): 5,324,400
- ObservationState (4,075 B): 29,252,880
- 2 token vaults (165 B each): 4,078,560
- LP mint (82 B): 1,461,600
- creator LP ATA (165 B): 2,039,280
- **Total ≈ 192,156,720 lamports ≈ 0.192 SOL** + tx fee (observed 85,000 lamports with priority fee on the sample tx).

**Faucet fit:** faucet.solana.com allows max 2 requests every 8 hours (stated on the site); secondary sources report up to 5 SOL per claim, higher allowance with validated GitHub sign-in; CLI `solana airdrop` is typically ~2 SOL/request with soft daily caps. **One 2–5 SOL claim covers 10–25 pool creations.**

**Known breakage reports (none block the DRaycpLY path):** cpi-example issues — #16 address mismatch (open), #12 devnet add-liquidity tx failure (May 2025), #15 anchor build error, #18 amm swap panic. raydium-cp-swap #60 "Account `owner` not provided" (closed Dec 2025, client-side). No reports of devnet AmmConfigs being closed/disabled; on-chain state confirms all configs open. SDK V2 caveats for devnet (from raydium-sdk-V2-demo README/FAQ): must pass the devnet API host and replace programIds; `raydium.api.fetchPoolById` etc. do NOT support devnet — use `getRpcPoolInfos` (RPC) for devnet pool data; freshly created pools take time to appear in the API.

## 5. Other graduation-path programs on devnet

- **Metaplex Token Metadata `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`: SAME address on devnet, live and executable.** Devnet last upgraded 2025-02-24T12:53:11Z (slot 363279440); mainnet last upgraded 2025-11-17T18:04:39Z (slot 380725176) — devnet lags ~9 months, but the CreateMetadataAccountV3/CreateV1 interface has been stable across that window (interface parity NOT byte-verified — see flags).
- **Devnet LP-lock (Burn & Earn) `DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC`: live, executable, actively used** (successful devnet txs 2026-08-04). Last upgraded 2025-05-29T09:22:51Z (slot 384060767), authority `441dvocuhsZCrW8zkGGmqYrbd9GWn7Y71YpDDkALTkaz`. Mainnet `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE` last upgraded 2025-08-23T17:58:08Z (slot 362025476), authority `FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK`. **Devnet lags the Aug-2025 mainnet upgrade; contents of that upgrade unverified** — verify the lock_cpmm instruction interface against the devnet binary before relying on it.
- Devnet program IDs cross-confirmed on docs.raydium.io "Program addresses": CPMM `DRaycpLY18…`, Burn & Earn `DLockwT7…`, admin `DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak`.

## Explicitly UNVERIFIED / flag for on-chain self-verification

1. **Whether devnet CPMM binary exactly matches any public source tag** — upgrade dates only were compared; no verified-build hash check was done. Per your D-031/D-032 doctrine, disassemble/probe the deployed devnet binary before trusting enum indices.
2. **Content of the mainnet 2025-08-23 LP-lock upgrade** vs the devnet 2025-05-29 binary — parity of lock instruction layout unverified.
3. **Exact faucet amount tiers** (5 SOL/claim is from secondary sources; faucet.solana.com itself only states "Maximum of 2 requests every 8 hours").
4. **Raydium devnet UI toggle** — issue #16 confirms a devnet-enabled Raydium UI exists (raydium.io/swap), but I could not verify the exact toggle URL/mechanism.
5. **Index-7 AmmConfig (`88hjD9…`) protocol/fund fee rates** — decoded fields shown are trade/create/creator only; it is absent from the API and admin-owned, so treat it as not-for-use.
6. PoolState (637 B) / ObservationState (4,075 B) sizes are from current master source; devnet's Dec-2025 binary should match (both postdate the last state-layout change), but confirm sizes from an actual devnet pool account before hardcoding rent.

## FACTS
- [high] The working devnet CPMM config API endpoint is https://api-v3-devnet.raydium.io/main/cpmm-config; it returns 7 AmmConfigs (indexes 0-6) all with createPoolFee 150000000 lamports and protocolFeeRate 120000, fundFeeRate 40000 (https://api-v3-devnet.raydium.io/main/cpmm-config)
- [high] Devnet CPMM AmmConfig index 0 is 5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy (tradeFeeRate 2500, createPoolFee 150000000, creatorFeeRate 2500, disable_create_pool false); index 1 HTVWgp8CbUsRNmRE1p9RBYqopxe2qiyApSkiTFLrfxaW (3000); index 2 A9qBhPy4k5UYW72hSgAkh1Epr2do69P54yzzcMV3yv6b (5000); index 3 EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz (10000); index 4 5Gt9qrPJ6FVe9VHtwF2W2JrFR6p9jmx4DxBkgfPdaApk (40000); index 5 G7YfJJp1TX1VtzN4V2yhPNSU23AKPSy1U2miRdwAByK5 (5000, creator 4000); index 6 8Pg5wr9H5i2GKbiH8315UiM1W9LJQT2tNiuqBeaoGKjz (50, creator 14950) — verified both via the devnet API and by decoding the raw accounts on devnet RPC (gPA dataSize 236) on 2026-08-08 (https://api-v3-devnet.raydium.io/main/cpmm-config)
- [high] An 8th on-chain devnet AmmConfig exists that the API does not list: index 7 = 88hjD9xpbXJn54PGHc2Xzx5GmFSp3tLfs9GdtsTAp8Em (trade_fee_rate 3500, create_pool_fee 150000000, creator_fee_rate 6500, disable_create_pool false, protocol/fund owner = devnet admin DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak) — RPC-decoded 2026-08-08 (https://explorer.solana.com/address/88hjD9xpbXJn54PGHc2Xzx5GmFSp3tLfs9GdtsTAp8Em?cluster=devnet)
- [high] All devnet AmmConfigs have disable_create_pool = false (byte at offset 9 = 0 in every account) as of 2026-08-08, so permissionless pool creation is enabled on every config (https://explorer.solana.com/address/5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy?cluster=devnet)
- [high] The devnet create-pool-fee receiver 3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy is a WSOL (So11111111111111111111111111111111111111112) SPL token account with authority DRayEuvQMUDHNsHLzNhzQsKnhCPPpbFqrau8L54XqGyW holding 1568.98 WSOL, and received 10 successful transactions in the ~7 hours before 2026-08-08T00:25Z — evidence of continuous live devnet pool creation (https://explorer.solana.com/address/3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy?cluster=devnet)
- [high] Permissionless CPMM initialize works on devnet today: tx 2Chmb9KjEMMRemQfsMsJT3ZxqLVPm3wV91SQJT34YtvNLeZpFACMcb3yt2ffpCUbSfxcJJcdMv7qUJLJWvXK3ao7 at 2026-08-08T00:24:46Z executed 'Program DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb / Instruction: Initialize' successfully with tx fee 85000 lamports (https://explorer.solana.com/tx/2Chmb9KjEMMRemQfsMsJT3ZxqLVPm3wV91SQJT34YtvNLeZpFACMcb3yt2ffpCUbSfxcJJcdMv7qUJLJWvXK3ao7?cluster=devnet)
- [high] raydium-cp-swap lib.rs devnet feature switches exactly three constants: declare_id (devnet DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb vs mainnet CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C), admin::ID (devnet DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak vs mainnet GThUX1Atko4tqhN2NaiTazWSeFWMuiUvfFnyJyUghFMJ), and create_pool_fee_reveiver::ID [sic] (devnet 3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy vs mainnet DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8) (https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/lib.rs)
- [high] The cpmm-cpi example's devnet cargo feature just forwards to the cp-swap crate: 'devnet = ["raydium-cp-swap/devnet"]', and the example depends on raydium-cp-swap git with features no-entrypoint+cpi — the official CPI crate is raydium-cp-swap itself; no official standalone raydium-cpmm-cpi crate exists (only third-party kirarisk/pinocchio-raydium-cpmm-cpi) (https://github.com/raydium-io/raydium-cpi-example/blob/master/cpmm-cpi/programs/cpmm-cpi/Cargo.toml)
- [high] The raydium-cpi-example README lists STALE devnet accounts for CPMM: Program CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW, AmmConfig 9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6, FeeReceiver G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2; on-chain check confirms 9zSzfkYy… is owned by the old CPMDW… program (still live, last upgraded 2025-06-26) and G11FKB… is a WSOL token account holding ~14065 SOL (https://github.com/raydium-io/raydium-cpi-example)
- [high] Open issue #16 (2025-08-18) documents that pools created via the cpi-example's CPMDW… devnet address are NOT tradable on the Raydium devnet-enabled UI, which uses DRaycpLY18… per docs.raydium.io; the issue remains open with no maintainer fix (https://github.com/raydium-io/raydium-cpi-example/issues/16)
- [medium] The devnet program id in raydium-cp-swap source was changed to the DRay… vanity set in commit 0011e63 'Style: update devnet ids' on 2025-07-25; creator fee support was added in PR #55 on 2025-08-18; audit fix #59 on 2025-11-04; Anchor 0.32.1 update 2025-12-29 (https://github.com/raydium-io/raydium-cp-swap/commits/master)
- [high] Devnet CPMM DRaycpLY18… was last upgraded at slot 430784616 = 2025-12-26T04:06:31Z (upgrade authority DRayw6sn9fCvbhx5ZLtAVGAgAk6qAAX7UT7urzkXTeM5); mainnet CPMMoo8L… was last upgraded at slot 425801539 = 2026-06-11T16:39:55Z (authority FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK) — devnet lags mainnet's binary by ~5.5 months (RPC ProgramData slot + getBlockTime, checked 2026-08-08) (https://explorer.solana.com/address/DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb?cluster=devnet)
- [medium] The mainnet-only June 2026 upgrade corresponds to PR #71 'Feat: support associated mint' (merged 2026-06-12): adds create_support_mint_associated / close_support_mint_associated instructions and SupportMintAssociated state, and modifies the Token-2022 mint-support check in initialize/initialize_with_permission; for plain SPL-Token mints the initialize interface is unchanged (https://github.com/raydium-io/raydium-cp-swap/pull/71)
- [high] Devnet CPMM exposes the creator-fee-era interface: its 2025-12-26 binary postdates creator-fee PR #55 (2025-08-18), on-chain devnet AmmConfigs carry nonzero creator_fee_rate at offset 108, and the devnet API returns creatorFeeRate per config; a creator-fee-era Initialize succeeded on devnet on 2026-08-08 (https://api-v3-devnet.raydium.io/main/cpmm-config)
- [high] Current AmmConfig layout (master): bump u8, disable_create_pool bool, index u16, trade_fee_rate u64, protocol_fee_rate u64, fund_fee_rate u64, create_pool_fee u64, protocol_owner Pubkey, fund_owner Pubkey, creator_fee_rate u64, padding [u64;15]; LEN = 8+1+1+2+4*8+32*2+8+8*15 = 236. PoolState::LEN = 637, ObservationState::LEN = 4075 (OBSERVATION_NUM = 100) (https://github.com/raydium-io/raydium-cp-swap/blob/master/programs/cp-swap/src/states/config.rs)
- [high] docs.raydium.io lists devnet program addresses: CPMM DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb, CLMM DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH, LaunchLab DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6, Burn & Earn DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC, devnet admin DRayqG9RXYi8WHgWEmRQGrUWRWbhjYWYkCRJDd6JBBak (https://docs.raydium.io/reference/program-addresses)
- [high] Metaplex Token Metadata is the SAME address on devnet (metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s), live and executable; devnet last upgraded 2025-02-24T12:53:11Z (slot 363279440), mainnet last upgraded 2025-11-17T18:04:39Z (slot 380725176) — devnet binary lags mainnet ~9 months (RPC-verified 2026-08-08) (https://explorer.solana.com/address/metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s?cluster=devnet)
- [high] Devnet LP-lock DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC is live, executable and actively used (successful devnet txs on 2026-08-04); last upgraded 2025-05-29T09:22:51Z (slot 384060767), authority 441dvocuhsZCrW8zkGGmqYrbd9GWn7Y71YpDDkALTkaz. Mainnet LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE last upgraded 2025-08-23T17:58:08Z (slot 362025476) — devnet lags the Aug-2025 mainnet upgrade; interface parity of that upgrade is UNVERIFIED (https://explorer.solana.com/address/DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC?cluster=devnet)
- [medium] faucet.solana.com states 'Maximum of 2 requests every 8 hours' with GitHub sign-in unlocking a higher airdrop limit; secondary sources report up to 5 SOL per claim; Metaplex's guide reports CLI airdrop max ~2 SOL per request with ~10-20 SOL daily soft limit — exact tier amounts NOT verifiable from the faucet page itself (rendered client-side) (https://faucet.solana.com/)
- [high] Raydium SDK V2 devnet caveats: you must provide the devnet API host and replace programIds with devnet ones; raydium.api.fetchPoolById and similar API methods do not support devnet pool/farm data — use getRpcPoolInfos via RPC; newly created pools take time to sync to the API (https://github.com/raydium-io/raydium-sdk-V2-demo)
- [high] Known devnet-related issue reports: raydium-cpi-example #16 (address mismatch, open), #12 (devnet add-liquidity tx failed, May 2025), #15 (anchor build error, Aug 2025), #18 (amm swap panic, Sep 2025); raydium-cp-swap #60 ('Account owner not provided' during pool creation, closed Dec 2025). No reports of the DRaycpLY devnet AmmConfigs being closed, disabled or unfunded (https://github.com/raydium-io/raydium-cpi-example/issues)

## NUMBERS
- Devnet CPMM create_pool_fee (all 8 AmmConfigs, on-chain) = 150000000 lamports (0.15 SOL) — identical to mainnet (https://api-v3-devnet.raydium.io/main/cpmm-config)
- Devnet AmmConfig count on-chain (dataSize 236) = 8 (indexes 0-7; API lists only 0-6) (https://explorer.solana.com/address/DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb?cluster=devnet)
- Rent-exempt PoolState (637 bytes, devnet) = 5324400 lamports (https://api.devnet.solana.com)
- Rent-exempt ObservationState (4075 bytes, devnet) = 29252880 lamports (https://api.devnet.solana.com)
- Rent-exempt token account (165 bytes) / mint (82 bytes) = 2039280 / 1461600 lamports (https://api.devnet.solana.com)
- All-in devnet CPMM pool creation cost (fee + rents for pool state, observation, 2 vaults, LP mint, creator LP ATA) = ~192156720 lamports ≈ 0.192 SOL + tx fee (85000 lamports observed) (https://explorer.solana.com/tx/2Chmb9KjEMMRemQfsMsJT3ZxqLVPm3wV91SQJT34YtvNLeZpFACMcb3yt2ffpCUbSfxcJJcdMv7qUJLJWvXK3ao7?cluster=devnet)
- Devnet fee receiver 3oE58… accumulated balance = 1568.98 WSOL (~10460 pool creations) (https://explorer.solana.com/address/3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy?cluster=devnet)
- Devnet CPMM DRaycpLY18… last upgrade = slot 430784616 = 2025-12-26T04:06:31Z (https://explorer.solana.com/address/DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb?cluster=devnet)
- Mainnet CPMM CPMMoo8L… last upgrade = slot 425801539 = 2026-06-11T16:39:55Z (PR #71 associated-mint era) (https://explorer.solana.com/address/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C)
- Devnet LP-lock DLockwT7… last upgrade / mainnet LockrWmn… last upgrade = 2025-05-29T09:22:51Z (slot 384060767) / 2025-08-23T17:58:08Z (slot 362025476) (https://explorer.solana.com/address/DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC?cluster=devnet)
- Devnet Metaplex Token Metadata last upgrade / mainnet = 2025-02-24T12:53:11Z (slot 363279440) / 2025-11-17T18:04:39Z (slot 380725176) (https://explorer.solana.com/address/metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s?cluster=devnet)
- faucet.solana.com rate limit = max 2 requests per 8 hours (anonymous); up to ~5 SOL/claim per secondary sources; GitHub login raises allowance (https://faucet.solana.com/)
- Devnet trade fee tiers (index: tradeFeeRate ppm) = 0:2500, 1:3000, 2:5000, 3:10000, 4:40000, 5:5000, 6:50, 7:3500 (https://api-v3-devnet.raydium.io/main/cpmm-config)

## RECOMMENDATIONS
- Target devnet CPMM DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb with AmmConfig index 0 = 5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy (0.25% trade fee, matches mainnet index 0) and fee receiver 3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy; do NOT use the raydium-cpi-example README's CPMDWBwJ…/9zSzfkYy…/G11FKB… accounts — they belong to a stale parallel deployment that the Raydium devnet UI/API ignore (issue #16).
- Budget ~0.2 SOL per devnet pool creation (0.15 SOL createPoolFee + ~0.042 SOL rents); a single faucet.solana.com claim (2 requests/8h, up to ~5 SOL) covers a full E2E run many times over — but harvest SOL early since faucet tiers were not verifiable from the site itself.
- Build with `anchor build -- --features devnet` (feature switches only program ID, admin ID, fee receiver in raydium-cp-swap); pull AmmConfig data at runtime from https://api-v3-devnet.raydium.io/main/cpmm-config or by gPA dataSize=236, not from hardcoded example lists.
- Per your verify-against-deployed-binary doctrine: devnet CPMM binary (2025-12-26) predates mainnet's 2026-06-11 upgrade (PR #71 associated-mint for Token-2022). Plain SPL-mint initialize is interface-identical, so graduation is unaffected, but confirm the devnet binary's IDL/instruction set on-chain before the gate run, and re-run the same E2E against mainnet interfaces before launch.
- The devnet LP-lock DLockwT7… lags mainnet LockrWmn…'s 2025-08-23 upgrade by ~3 months; verify the lock-CPMM-position instruction layout against the deployed devnet binary (it is live and used as of 2026-08-04) rather than assuming parity with mainnet.
- Metaplex Token Metadata is the same ID on devnet (metaqbxx…) and live; no address change needed, but note devnet's binary is ~9 months older than mainnet's.
- For devnet pool verification after creation, use RPC (getRpcPoolInfos / direct account decode) — Raydium's pool-info API endpoints do not serve devnet pool data and new pools sync slowly.
- Cross-check disable_create_pool on the chosen AmmConfig immediately before the gate run (cheap getAccountInfo, byte offset 9) — it is admin-mutable and your run depends on it staying false.
