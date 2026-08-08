## Security threat model for a Solana bonding-curve launchpad (as of Aug 2026)

Consumable as REDTEAM.md input and as property-test invariant specs. Every claim is cited in `facts`. Where a source did not confirm a low-level detail (e.g. exact rounding direction in pump.fun's compiled program), I flag it as UNVERIFIED — treat those as invariants to *establish by your own test*, not as facts about a specific competitor.

---
### 1. Known launchpad exploits and incidents

**pump.fun — May 16, 2024 — insider "flash-loan"/bonding-curve drain (~12,300 SOL / ~$1.9M).**
Mechanics: an account (5PXxuZ…) that acted as a global **withdraw authority / cosigner** for bonding curves was used (compromised private key of a former employee) to withdraw ALL liquidity directly out of bonding curves instead of migrating them to Raydium. The attacker seeded the manipulation with a ~129 SOL flash loan (borrowed and repaid in one tx) to buy curves to 100% completion, then the privileged cosigner drained the curve SOL vaults. Root cause is **operational + design**: a single off-curve key could move curve funds; there was no program-enforced constraint that curve SOL can only leave via deterministic, permissionless migration. Lesson: curve vaults must be **program/PDA-controlled**, withdrawal of principal must be *impossible for any single external key*, and migration must be **permissionless + deterministic** (pump.fun's current design makes `migrate` permissionless and idempotent, requiring `complete==true` and real reserves == 0).

**Raydium — Dec 16, 2022 — admin-key compromise (~$5.5M).** A trojan stole the pool **owner/authority private key**; attacker called the privileged `withdraw_pnl()` to drain pools without depositing LP tokens. Root cause: a single wallet held withdraw authority across many pools (centralization/blast-radius). Fix removed admin control over the exploited parameters. (This is the closest well-documented Raydium incident; **there is no notable January 2025 Raydium *launchpad* exploit on record** — the query's "Jan 2025?" appears to conflate events. LaunchLab launched April 2025 and has no exploit on record.)

**Raydium — June 10, 2026 — legacy/deprecated AMM pools (~$1.34M).** Five dormant pools from an old AMM version were drained; attacker bypassed **validation logic in the deprecated program using a fake mint address** and minted LP tokens to withdraw liquidity undetected. No live-UI users affected. Lesson: **mint/account validation must be exhaustive** (validate the mint actually matches the pool's configured mint — a "type cosplay"/fake-mint class bug); deprecated code paths remain attackable if left upgrade-live.

**Meteora Dynamic Bonding Curve — Code4rena audit Aug 22–Sep 12, 2025 (findings, patched, not an in-the-wild loss).** Two medium findings directly relevant:
- **Swap rate-limiter bypass via `swap2`:** `validate_single_swap_instruction()` checked only `Swap::DISCRIMINATOR`, not `Swap2::DISCRIMINATOR`, so an attacker could bundle up to ~16 swaps in one tx and defeat the single-swap anti-sniping guard. Fixed by PR Sep 5, 2025. Lesson: **anti-abuse checks must cover every instruction variant** that performs the guarded action.
- **Zero-fee trades:** `FeeRateLimiter::is_zero_rate_limiter()` ignored `cliff_fee_numerator`, so `cliff_fee_numerator=0` passed validation and produced free trades below the documented 0.01% floor. Lesson: **enforce a hard minimum-fee floor on every code path** (expired rate limiter, alternate instruction, cliff fee). Low findings included: `#[cfg(feature="local")]` admin bypass, missing `is_migrated==0` check (re-init migration metadata), an `owner` treated as `UncheckedAccount` with no signer requirement (unauthorized lock/claim), permissionless migration-metadata front-running, hard-coded admin keys with no multisig/timelock, and `.unwrap()` panics on-chain.

**Meteora DBC — Oct 2025 wash-trading guardrails.** Meteora publicly acknowledged inorganic activity/wash trading and added guardrails: a minimum trading fee (reported 0.25%–0.50%) so pools can't be cheaply wash-traded, plus a **genesis fee scheduler** starting fees up to ~90% at open and decaying (linear/exponential) to deter snipers.

**Moonshot (DEX Screener, June 2024)** — constant-product/virtual-reserve curve, graduation at 500 SOL (~$73k), audited by Ackee (April); **no smart-contract exploit on record** (platform risk is downstream rug/volatility, not contract).

---
### 2. Graduation sniping, curve-completion & pool-creation frontrunning

- **Graduation/curve-completion sniping:** bots watch on-chain curve state (real-token-reserves approaching 0, market cap near the graduation threshold, `complete` flag) and race to buy the newly-created migrated pool in the **same block as migration**, then dump on retail who buy at/after migration (buying at migration is already "exit liquidity"). Mitigated in practice by moving migration in-house (pump.fun's **PumpSwap**, live Mar 20, 2025, replaced the 6-SOL Raydium migration and its bot-flooded pool-open window).
- **Pool-creation frontrunning on permissionless AMMs:** sniper bots detect the pool-init tx and try to be first swap in the new pool (documented pattern: BLAST-SOL pool, a swap attempted 49s before initialization). Any permissionless `initialize_pool` is a race; the **first-swap/first-LP position is MEV**.
- **Bundler sniping (same-block dev+snipe):** ~95% of Solana stake runs Jito; Jito **bundles group up to 5 txs atomically in order**. Launch bundlers deploy the token and bundle-buy from many wallets in **block 0**, so external snipers "can't react" but the *dev* captures 20–40% of supply invisibly — a concealed-supply/insider risk for buyers, not a contract bug.

---
### 3. Curve-math pitfalls (pump.fun reference + general)

pump.fun uses Uniswap-V2 constant product `k = virtual_token_reserves * virtual_sol_reserves` with **virtual reserves** (worked example: ~1.073e15 virtual tokens, 30 SOL virtual, 793.1e12 real tokens, 1B total supply) so early price is finite. Key asymmetries and hazards:
- **Fee model asymmetry:** on **buy**, fee is taken **fee-in** (deducted from input SOL *before* curve math: `input = (sol-1)*10000/((protoBps+creatorBps)+10000)`); on **sell**, fee is **fee-on-output** (subtracted *after* curve math, then clamped to 0 for dust). Getting fee-on-top vs fee-in inconsistent is a classic value leak.
- **Overflow:** the sell multiply `amount * virtual_sol_reserves` **must be widened to u128** on-chain; pump.fun observed 83% of landed sells exceeded a naive u64 bound (some >2000×), forcing chunked sells. All `amount*reserve` products must be u128 (or u256-emulated) before dividing back to u64.
- **Rounding direction (UNVERIFIED in pump's binary — establish by test):** the safe rule is *round in the direction that preserves or grows k for the pool* — tokens_out on buy rounds DOWN, sol_out on sell rounds DOWN, so the **pool eats the dust** on both sides. A round-trip (buy then immediately sell the exact tokens received) must never net positive.
- **Reserve cap / last-token edge:** buy output is clamped to `min(tokens_out, real_token_reserves)`; the final buy that exhausts the curve needs the SOL/token accounting to stay exact (refund overpay or cap input) or the last buyer over/under-pays. Sells of dust where fee > gross must clamp to 0, never underflow.
- **Completion is one-way:** `complete` set true at end of any buy that exhausts real reserves; never reverts (sells cannot "uncomplete"); no buy/sell allowed once complete.

---
### 4. Anchor / program best practices 2026

- **Account validation:** every account constrained — `has_one` (bind curve↔mint↔authority), `seeds`+`bump` (store canonical bump, don't recompute), `owner`/`token::mint`/`address=` checks. Replace `UncheckedAccount`/`AccountInfo` with typed `Account<'info,T>` or explicit `constraint=`. Validate token-account `mint` matches expected mint (defeats fake-mint/type-cosplay — the Raydium June-2026 class).
- **Signer checks on withdrawal:** fee/treasury withdrawal requires the fee authority as `Signer`; **no single external key may move curve principal** (the pump.fun lesson) — vaults are PDAs, moved only via `with_signer(seeds)` under program logic.
- **Arithmetic:** set `overflow-checks = true` in `[profile.release]` (Anchor **disables it by default** since 0.30.0 unless explicitly set) AND use `checked_add/sub/mul/div` in hot paths; widen to u128 for products.
- **Reinit / revival:** guard init-once accounts; note Anchor **0.30.0 stopped writing `CLOSED_ACCOUNT_DISCRIMINATOR`** — closing must zero data and the program must reject zombie/revived accounts (Solana GC runs at slot end, so a closed account can be re-funded and revived within a tx). Use `close = recipient`.
- **Upgrade authority:** multisig (Squads) + timelock, or immutable after audit; hard-coded single admin keys were an explicit audit finding against Meteora.
- **Events for indexers:** prefer `emit_cpi!` (CPI-based events survive log truncation and are reliably indexable) over `emit!`/`msg!` logs, which can be truncated/dropped.
- **security.txt:** embed the Neodyme `solana-security-txt` `#[link_section]` block (contacts, policy, source, auditors) so whitehats can reach you from the program address alone.

---
### 5. Economic / MEV attacks and mitigations in practice

- **Bundler same-block dev+snipe** (concealed supply) → mitigations seen: **max-buy-per-tx / wallet caps in the first N slots**, **genesis fee schedule** (fees ~90%→low), **creator/dev-first-buy-only** window, bot taxes, private orderflow relays.
- **Wash trading / fee farming** (inflate volume, or in reward-bearing designs farm emissions) → mitigation: a **minimum trade fee floor** so round-trips are net-negative (Meteora's 0.25–0.5% floor); never let any path reach 0 fee.
- **Sandwiching curve buys** → mitigation: enforce **min-out slippage after fee**, high-fee launch window, private/Jito routes; steep curves degrade arb edge.
- **Rate-limit must cover all instruction variants** (the `swap2` bypass) — a single-swap-per-tx guard is only as strong as its weakest entry point.

---
### 6. Design principles

- **Oracle-free / sysvar-free pricing:** the curve prices purely from internal reserves — **no external price feed, no Clock/slot in value-critical math**. Time (Clock) may drive a fee schedule only, and must tolerate validator clock drift; never derive a price or payout from slot/timestamp.
- **Rent / close griefing:** fund created accounts to rent-exemption (rent-exempt accounts are not GC'd, so an attacker cannot force-close a properly funded vault by draining lamports); never assume an account you didn't create is still open/uninitialized.
- **Token standard:** launchpads predominantly use **classic SPL** for the curve token because it has no surprise transfer semantics; Token-2022 is opt-in (pump.fun `create_v2`) with a **strict extension allowlist**. If accepting Token-2022, reject/allowlist per extension and use **balance-delta accounting** (measure vault balance before/after transfer) rather than trusting the transfer amount.

---
### 7. NAMED INVARIANTS (property-test spec)

**Curve math**
- `INV-ROUND-BUY`: `tokens_out(buy(x))` uses floor division — buyer never gets more tokens than the exact real-valued curve output (pool keeps dust). ∀ x>0.
- `INV-ROUND-SELL`: `sol_out(sell(t))` uses floor division — seller never gets more SOL than exact (pool keeps dust). ∀ t>0.
- `INV-ROUNDTRIP-NONPROFIT`: `sol_out(sell(tokens_out(buy(x)))) <= x` ∀ x>0 (immediate round-trip never profits, fees included; the headline invariant `sol_out(sell(x)) <= sol_in(buy(x))`).
- `INV-K-NONDECREASING`: `vtr_after * vsr_after >= vtr_before * vsr_before` after any buy/sell (rounding must preserve or grow k for the protocol).
- `INV-U128-WIDEN`: every `amount * reserve` product is computed in u128 (or wider) before narrowing; final value fits u64; assert no wrap. ∀ inputs up to reserve bounds.
- `INV-RESERVE-CAP`: `tokens_out(buy(x)) <= real_token_reserves` ∀ x (cannot buy past the curve; last buy clamps and reconciles SOL).
- `INV-SOL-CONSERVATION`: on-chain SOL vault lamports == accounted `real_sol_reserves` after every instruction (no unaccounted delta).
- `INV-COMPLETE-MONOTONE`: `complete` is one-way (false→true only); every buy/sell reverts when `complete==true`.
- `INV-MONOTONIC-PRICE`: marginal price is non-decreasing in cumulative tokens sold from the curve for all valid configs (no param makes price fall as supply sells).
- `INV-SELL-NO-UNDERFLOW`: `sol_out_raw - fee` never underflows; result clamped to ≥0 for dust where fee ≥ gross.

**Slippage / fees**
- `INV-SLIPPAGE-BUY`: buy reverts unless `tokens_out >= min_tokens_out` (and/or `sol_cost <= max_sol_cost`), checked *after* fee+curve.
- `INV-SLIPPAGE-SELL`: sell reverts unless `sol_out >= min_sol_output`, checked *after* fee subtraction.
- `INV-FEE-FLOOR`: effective fee bps ≥ configured minimum (>0) on EVERY path (alt instruction, expired rate-limiter, cliff=0). (Meteora zero-fee finding.)

**Structural / Anchor**
- `INV-VAULT-PDA-ONLY`: curve SOL/token principal leaves only via program logic signing with PDA seeds; no external key can withdraw principal. (pump.fun lesson.)
- `INV-SIGNER-WITHDRAW`: fee withdrawal requires fee-authority `Signer`; unauthorized caller reverts.
- `INV-MINT-MATCH`: every token account's `mint` == the curve's configured mint; fake/substituted mint reverts. (Raydium June-2026 class.)
- `INV-HAS-ONE`: `bonding_curve.mint==mint`, vault authority == bonding_curve PDA; substituted accounts revert.
- `INV-NO-REINIT`: initialized curve/migration-metadata cannot be re-initialized (`is_migrated`/`is_initialized` guarded).
- `INV-NO-REVIVAL`: a closed account cannot be revived and re-accepted in the same or later tx (discriminator/zeroing checked).
- `INV-CPI-PINNED`: all CPI target program IDs (token program, AMM) are pinned constants; arbitrary program reverts.
- `INV-RATE-LIMIT-ALL-PATHS`: single-swap/anti-sniping guard applies to every swap instruction variant. (swap2 bypass.)

**Token-2022 / oracle-free / rent**
- `INV-T22-ALLOWLIST`: mints with disallowed extensions (transfer hook, transfer fee, permanent delegate, non-null freeze authority, default-frozen, confidential-transfer, mint-close) are rejected at intake.
- `INV-BALANCE-DELTA`: when transfer-fee mints are permitted, credited amount == measured (post_balance − pre_balance), never the requested amount.
- `INV-NO-ORACLE`: pricing/payout is a pure function of internal reserves; no Clock/slot/external feed feeds value-critical math (fee schedule may read Clock but is non-value-critical and drift-tolerant).
- `INV-RENT-EXEMPT`: all program-created accounts are funded to rent-exemption; program never assumes an un-created account is uninitialized.

**Economic (policy invariants, launch-window)**
- `INV-MAXBUY-EARLY`: per-tx buy ≤ cap during first N slots (or fee schedule high→low) — anti-bundler.
- `INV-CREATOR-FIRST`: optional creator-only/dev-first buy in launch window enforced.

## FACTS
- [high] pump.fun's May 16, 2024 exploit drained ~12,300 SOL (~$1.9M); pump.fun attributed it to a former employee who used a privileged 'withdraw authority' to compromise internal systems via a bonding-curve attack. (https://www.tradingview.com/news/cointelegraph:5200dae5d094b:0-memecoin-launcher-pump-fun-claims-ex-employee-behind-1-9m-exploit/)
- [high] In the pump.fun exploit, the attacker used flash loans to buy tokens until bonding curves hit 100% completion, then accessed the curve liquidity; the account 5PXxuZ cosigned all attacker txs and itself withdrew all liquidity from the bonding curve (contradicting its programmed behavior of creating a Raydium pool) — the withdraw-authority private key was compromised. (https://quadrigainitiative.com/casestudy/pumpfuninsiderflashloanexploit.php)
- [medium] The pump.fun attacker initiated a ~129 SOL flash loan (borrowed and repaid within one transaction) to manipulate the bonding curve. (https://quadrigainitiative.com/casestudy/pumpfuninsiderflashloanexploit.php)
- [high] pump.fun's bonding curve uses the Uniswap-V2 constant product formula k = virtual_token_reserves * virtual_sol_reserves with virtual reserves larger than real reserves so early price is finite (~30 SOL virtual injected at genesis). (https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism)
- [high] pump.fun buy fee is deducted from input SOL before curve math (fee-in): input = (solAmount-1)*10000/((protocolFeeBps+creatorFeeBps)+10000); sell fee is subtracted from output after curve math (fee-on-output) and clamped to 0 for dust. (https://github.com/nirholas/pump-fun-sdk/blob/main/docs/bonding-curve-math.md)
- [high] On pump.fun the sell multiply amount*virtualSolReserves is widened to u128 on-chain; 83% of landed sells exceeded a u64::MAX-derived bound (some by >2000x), requiring chunked sells — evidence that u64 products overflow and must be computed in u128. (https://github.com/nirholas/pump-fun-sdk/blob/main/docs/bonding-curve-math.md)
- [high] pump.fun buy output is clamped to min(tokensOut, realTokenReserves); the curve is 'complete' when realTokenReserves reaches zero and the complete flag never reverts to false (sells cannot uncomplete a curve); no buy/sell is possible after completion. (https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism)
- [high] pump.fun migrate is permissionless and idempotent, requiring complete==true and zero real reserves before migrating accumulated real_sol_reserves to PumpSwap. (https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism)
- [high] Meteora DBC audit (Code4rena, Aug 22–Sep 12, 2025) found a swap rate-limiter bypass: validate_single_swap_instruction() checked only Swap::DISCRIMINATOR, not Swap2::DISCRIMINATOR, letting an attacker bundle up to ~16 swaps in one tx and defeat anti-sniping; fixed by public PR Sep 5, 2025. (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- [high] Meteora DBC audit found FeeRateLimiter::is_zero_rate_limiter() ignored cliff_fee_numerator, so cliff_fee_numerator=0 passed validation and produced zero-fee trades below the documented 0.01% minimum fee floor. (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- [high] Meteora DBC audit low findings included: #[cfg(feature="local")] unconditionally bypassing admin checks; missing is_migrated==0 check allowing migration-metadata re-init; an owner account treated as UncheckedAccount with no signer requirement (unauthorized lock/claim); permissionless migration-metadata front-running; hard-coded admin keys with no multisig/timelock; and .unwrap() panics in on-chain code. (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- [medium] Meteora publicly acknowledged inorganic activity and wash trading on DBC and announced guardrails were coming. (https://x.com/MeteoraAG/status/1972472191158751244)
- [low] Meteora's anti-sniper genesis fee scheduler starts fees very high (up to ~90%) at pool opening then reduces rapidly (linearly or exponentially); a swap rate limiter prevents bundling multiple swaps in one tx; a reported minimum trading fee (0.25%/0.50%) makes wash trading uneconomical. (https://www.gate.com/learn/articles/what-is-moonshot-all-you-need-to-know-about-moonshot/4946)
- [high] The Raydium exploit analyzed by CertiK occurred Dec 16, 2022: a trojan compromised the owner's private key; the attacker used the privileged withdraw_pnl() to drain ~$5.5M from pools without depositing LP tokens; root cause was a single wallet holding withdraw authority across many pools; fix removed admin control over the exploited parameters. (https://www.certik.com/resources/blog/raydium-protocol-exploit-incident-analysis)
- [high] On June 10, 2026 an attacker drained ~$1.34M from five deprecated/legacy Raydium AMM pools by bypassing validation logic in the deprecated program (using a fake mint address) to mint LP tokens and withdraw liquidity undetected; no live-UI users were affected. (https://decrypt.co/370700/solana-exchange-raydium-exploit-defi-attacks-grow)
- [medium] Raydium LaunchLab launched April 2025 as a permissionless bonding-curve launchpad; Raydium contracts (including LaunchLab) were audited by Kudelski, OtterSec, MadShield, Halborn and Sec3, with a $505,000 max Immunefi bug bounty; no LaunchLab exploit is on record. (https://docs.raydium.io/products/launchlab)
- [high] pump.fun launched PumpSwap on March 20, 2025; graduated tokens migrate there instead of Raydium, eliminating the prior 6-SOL Raydium migration fee and the bot-flooded pool-open migration window. (https://www.blocmates.com/news-posts/pump-fun-introduces-pumpswap-a-new-dex-for-graduated-token-listings)
- [medium] Buying a pump.fun token at migration is already 'exit liquidity'; profitable positioning happens while the token is still bonding, and traders watch progress indicators (curve near completion) — the basis of graduation sniping. (https://blog.bananagun.io/blog/how-to-snipe-pump-fun-tokens-before-they-migrate-to-raydium)
- [medium] Sniper bots detect pool-creation transactions and try to be among the first to trade a new pool; e.g., a swap was attempted 49 seconds before the BLAST-SOL pool was initialized, causing an error — evidence of pool-creation frontrunning races on permissionless AMMs. (https://arxiv.org/pdf/2504.18055)
- [high] ~95% of Solana stake runs the Jito validator client; Jito bundles group up to 5 transactions atomically in exact order — used to deploy a token and bundle-buy from multiple wallets in block 0 so external snipers cannot react (concealed dev supply of 20-40%). (https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana)
- [medium] At token launch sniper bots front-run deploys; by the time real buyers see the token, bots may already hold 20-40% of supply; developers counter with bundlers that atomically buy in block 0. (https://solbundler.app/)
- [medium] Fair-launch launchpad tooling in 2025-2026 uses wallet caps, bot taxes, timed releases, staged bonding curves, and private orderflow relays to reduce sandwich attacks; but the edge reappears where rules are soft (sybil sets, curve timing, fee bidding, private routes). (https://cryptodaily.co.uk/2026/05/memecoin-launchpads-fair-launch-bots)
- [high] Token-2022 extensions are footguns for AMM/launchpad programs: transfer fees make received amount < sent amount (breaks escrow accounting — use TransferCheckedWithFee or balance-delta); permanent delegate can drain any account; freeze authority / default-frozen can lock vaults; transfer hooks run arbitrary code; mint-close allows reinitialization bypassing prior extensions; confidential transfers hide balances — mitigation is to allowlist mints by extension and validate mints at intake. (https://neodyme.io/en/blog/token-2022/)
- [high] pump.fun supports two token standards: classic SPL Token via create, and Token-2022 (with extensions like mayhem mode / cashback) via create_v2. (https://deepwiki.com/pump-fun/pump-public-docs/3-pump-program)
- [high] Anchor 0.30.0 made overflow-checks explicit and does not enable it by default after initial workspace creation; overflow-checks=true belongs in [profile.release], and checked_add/sub/mul/div should replace raw operators to prevent overflow/underflow. (https://github.com/coral-xyz/anchor/issues/1759)
- [high] Solana revival/zombie-account attacks exploit that garbage collection runs only at slot end: between instructions a closed (zero-lamport) account still exists and can be re-funded and revived; since Anchor 0.30.0 the close constraint no longer sets CLOSED_ACCOUNT_DISCRIMINATOR, so programs must zero data and reject revived accounts. (https://fuzzinglabs.com/revival-attacks-solana-programs/)
- [high] The Neodyme solana-security-txt crate embeds an on-chain .security.txt ELF section (via #[link_section]) with contact/policy/source/auditor info so whitehat researchers can identify and reach a program from its address alone. (https://github.com/neodyme-labs/solana-security-txt)
- [medium] Anchor best practice: constrain every account with seeds/has_one/token::mint, store bumps rather than recomputing, replace AccountInfo/UncheckedAccount with typed Account or explicit constraint=, verify CPI target program IDs, sign PDA CPIs with with_signer(seeds), and use #[account(close = recipient)] to prevent rent drainage and safely zero state. (https://www.vultbase.com/articles/anchor-program-security-solana)
- [medium] Moonshot (launched June 2024 by DEX Screener) uses a constant-product curve with virtual reserves, graduates to Raydium at 500 SOL (~$73k), was audited by Ackee, and has no reported smart-contract exploit. (https://www.gate.com/learn/articles/what-is-moonshot-all-you-need-to-know-about-moonshot/4946)
- [medium] Raydium CPMM (CP-swap) is cheaper to create than AMM v4, supports Token-2022, and is the recommended default for permissionless listings; Raydium supports permissionless pool creation by anyone. (https://docs.raydium.io/user-flows/create-cpmm-pool)

## NUMBERS
- pump.fun May 2024 loss = ~12,300 SOL (~$1.9M) (https://www.tradingview.com/news/cointelegraph:5200dae5d094b:0-memecoin-launcher-pump-fun-claims-ex-employee-behind-1-9m-exploit/)
- pump.fun exploit flash-loan size = ~129 SOL (https://quadrigainitiative.com/casestudy/pumpfuninsiderflashloanexploit.php)
- pump.fun exploit window (UTC) = May 16 2024, 15:21-17:00 (https://quadrigainitiative.com/casestudy/pumpfuninsiderflashloanexploit.php)
- pump.fun genesis virtual SOL reserves = ~30 SOL (https://deepwiki.com/pump-fun/pump-public-docs/3.1-pump-bonding-curve-mechanism)
- pump.fun worked-example reserves = ~1.073e15 virtual tokens, 793.1e12 real tokens, 1B total supply (https://github.com/nirholas/pump-fun-sdk/blob/main/docs/bonding-curve-math.md)
- pump.fun landed sells exceeding naive u64 bound = 83% (some >2000x) (https://github.com/nirholas/pump-fun-sdk/blob/main/docs/bonding-curve-math.md)
- pump.fun historical Raydium graduation mcap / migration fee = ~$69,000 / 6 SOL (https://www.blocmates.com/news-posts/pump-fun-introduces-pumpswap-a-new-dex-for-graduated-token-listings)
- PumpSwap launch date = March 20, 2025 (https://www.blocmates.com/news-posts/pump-fun-introduces-pumpswap-a-new-dex-for-graduated-token-listings)
- Moonshot graduation threshold = 500 SOL (~$73,000) (https://www.gate.com/learn/articles/what-is-moonshot-all-you-need-to-know-about-moonshot/4946)
- Meteora DBC swap2 bypass bundle count = up to ~16 swaps per tx (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- Meteora documented minimum base fee = 0.01% (bypassable to 0 via cliff_fee=0 finding) (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- Meteora genesis fee scheduler opening fee = up to ~90% decaying (https://www.gate.com/learn/articles/what-is-moonshot-all-you-need-to-know-about-moonshot/4946)
- Meteora DBC audit window = Aug 22 - Sep 12, 2025 (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- Meteora swap2 fix PR date = Sep 5, 2025 (https://code4rena.com/reports/2025-08-meteora-dynamic-bonding-curve)
- Raydium Dec 2022 admin-key loss = ~$5.5M (https://www.certik.com/resources/blog/raydium-protocol-exploit-incident-analysis)
- Raydium legacy-pool exploit (2026) = ~$1.34M ($900k USDC, $357k SOL, $86k RAY) on June 10, 2026 (https://decrypt.co/370700/solana-exchange-raydium-exploit-defi-attacks-grow)
- Raydium LaunchLab launch = April 2025 (https://docs.raydium.io/products/launchlab)
- Raydium bug bounty max reward = $505,000 (Immunefi) (https://docs.raydium.io/products/launchlab)
- Jito stake share / bundle size = ~95% of stake; up to 5 txs per bundle (https://rpcfast.com/blog/jito-explained-bundles-tips-mev-solana)
- Typical sniper-captured supply at launch = 20-40% (https://solbundler.app/)

## RECOMMENDATIONS
- Make curve principal PDA-controlled and unwithdrawable by any single external key: SOL/token vaults are program PDAs, moved only via with_signer(seeds) under buy/sell/migrate logic. Migration must be permissionless, deterministic, and idempotent (gate on complete==true AND real_reserves==0). This closes the pump.fun-2024 insider-drain class. Assert INV-VAULT-PDA-ONLY and INV-SOL-CONSERVATION.
- Compute all curve products (amount*reserve) in u128 (or wider) before narrowing to u64, and enable overflow-checks=true in [profile.release] AND use checked_* in hot paths (Anchor 0.30.x does not enable overflow-checks by default). Property test INV-U128-WIDEN with fuzzed reserves near u64::MAX/2.
- Fix rounding direction so the pool eats dust on BOTH sides: tokens_out(buy) rounds down, sol_out(sell) rounds down. Prove INV-ROUNDTRIP-NONPROFIT: sol_out(sell(tokens_out(buy(x)))) <= x for all x (the requested sol_out(sell(x)) <= sol_in(buy(x))), and INV-K-NONDECREASING after every trade.
- Enforce a hard minimum-fee floor on EVERY code path (alternate instructions, expired rate limiter, cliff fee), and confirm no path yields a zero-fee trade — directly mirrors both Meteora Code4rena findings. Property test INV-FEE-FLOOR across all swap variants and INV-RATE-LIMIT-ALL-PATHS (guard every swap discriminator, not just one).
- Enforce slippage AFTER fee+curve on both sides: buy requires tokens_out>=min_out (or sol_cost<=max_cost), sell requires sol_out>=min_out; clamp dust sells to >=0 with no underflow. Assert INV-SLIPPAGE-BUY/SELL and INV-SELL-NO-UNDERFLOW.
- Validate mints exhaustively to kill fake-mint / type-cosplay (the Raydium June-2026 class): every token account's mint == the curve's configured mint, plus has_one bindings (curve.mint==mint, vault authority==curve PDA), seeds+stored bump, and pinned CPI program IDs. Assert INV-MINT-MATCH, INV-HAS-ONE, INV-CPI-PINNED.
- Default to classic SPL for the curve token. If Token-2022 is accepted, apply a strict per-extension allowlist (reject transfer hook, transfer fee, permanent delegate, non-null freeze authority, default-frozen, confidential transfer, mint-close/reinit) and use balance-delta accounting (post-pre) instead of trusting transfer amounts. Assert INV-T22-ALLOWLIST and INV-BALANCE-DELTA.
- Prevent reinitialization and revival: guard init-once curve and migration-metadata state (is_initialized/is_migrated), use close=recipient, and reject zombie/revived accounts explicitly (Anchor 0.30.0 no longer writes CLOSED_ACCOUNT_DISCRIMINATOR). Fund all created accounts to rent-exemption. Assert INV-NO-REINIT, INV-NO-REVIVAL, INV-RENT-EXEMPT.
- Keep pricing oracle-free and sysvar-free for value: price/payout is a pure function of internal reserves; Clock/slot may drive only a non-value-critical fee schedule and must tolerate clock drift. Assert INV-NO-ORACLE.
- Add launch-window economic guards against bundler snipes and wash trading: max-buy-per-tx / wallet caps in the first N slots (or a high->low genesis fee schedule), optional creator/dev-first-buy window, and a fee floor that makes wash round-trips net-negative. Assert INV-MAXBUY-EARLY, INV-CREATOR-FIRST, INV-FEE-FLOOR.
- Use emit_cpi! (CPI events) rather than emit!/msg! logs so indexers reliably capture trades/graduations (logs can be truncated), and embed a Neodyme solana-security-txt block so whitehats can reach you from the program address.
- Governance/ops: put upgrade authority behind a multisig (Squads) + timelock or make the program immutable after audit; never ship hard-coded single admin keys (an explicit Meteora audit finding) and never a #[cfg(feature="local")]-style admin bypass. Require the fee authority as Signer on withdrawals (INV-SIGNER-WITHDRAW).
- Note the query's 'Raydium Jan 2025?' has no matching launchpad exploit on record — do not model a phantom incident. The real Raydium reference points are Dec-2022 (admin-key drain via withdraw_pnl, $5.5M) and June-2026 (legacy-pool fake-mint validation flaw, $1.34M); LaunchLab (Apr 2025) is audited (OtterSec/MadShield/Halborn/Sec3) with no exploit.
