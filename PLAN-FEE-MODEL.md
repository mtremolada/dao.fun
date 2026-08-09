# PLAN — how dao.fun earns, before and after graduation

Operator directive (2026-08-09): *"what would be a good model for the
protocol to earn both before and after graduating, we want to be reasonable
and competitive"*.

Evidence base: `research/launchpad/graduation-economics.md` (measured on
deployed binaries and live mainnet state), D-049 (G0 lock verification),
`tests/pump-migration-economics.integration.test.ts`.

---

## 1. What we are competing against (measured, not quoted)

| | curve fee | who pays graduation | post-graduation creator stream |
|---|---|---|---|
| **pump.fun, Raydium era** | 1.00% | **6 SOL from the raise** against ~0.4 SOL of real cost — ~5.32 SOL margin per graduation | none — LP minted to pump's wallet, then burned |
| **pump.fun today** | **1.25%** (0.95 protocol / 0.30 creator) | the raise — 0.015 SOL fee, mostly rent; cranker pays 0 | PumpSwap, market-cap tiered: **creator 0.95%** of volume at fresh-graduate mcap, decaying to 0.05% above ~98k SOL mcap |
| **letsbonk.fun** (LaunchLab) | **1.50%** (0.25 Raydium + 1.25 platform) | Raydium's crank wallet, 0.2135 SOL, 100% of the raise reaches the pool | **none** — `creator_scale = 0`; LP either burned 99.9999% or 100% to a *platform* fee key |
| **Meteora DBC** | configurable; protocol takes 20% of it | the **cranker**, billed exactly via `flash_rent`; plus an optional 0–99% cut of the raise | configurable locked-LP split, partner vs creator; ≥10% must stay locked at 24h |
| **Moonit** | — | — | LP locked permanently, fees auto-claimed **in SOL and airdropped daily**, **80% creator / 20% platform** |
| **Boop** | all fees to the platform pre-graduation | **6 SOL from the raise** (80 SOL migrates) | — |
| **StonkFun** | 1% or 4% pool | no curve — mints and locks a one-sided CLMM position | 50/50 creator/platform, but the fee keys sit in **platform bot wallets** — the creator's share is an off-chain promise |
| **dao.fun today** | 1.00% (0.70 / 0.30) | the raise — 0.2155 SOL | nothing — LP is burned |
| **dao.fun proposed** | 1.00% (0.70 / 0.30) | the coin's own protocol fees; **100% of the raise reaches the pool** | Raydium CPMM tier 1: **DAO 0.756%**, protocol 0.084%, Raydium 0.16% |

Five things fall out, all of which the proposal already leans into:

- **The 6 SOL era is over and reviving it would be conspicuous.** pump's
  Raydium-era fee was verified at exactly 6,000,000,000 lamports deducted
  from the raise on four separate graduations (FWOG, GOAT, FARTCOIN, PNUT)
  against ~0.4 SOL of actual cost. Today Raydium eats 0.2135 SOL out of its
  own wallet so the full 85 SOL enters the pool, and pump charges 0.015 SOL.
  Boop still takes 6 SOL and is the outlier, not the norm.
- **On the curve we match pump and undercut everyone on price.** pump's
  effective curve fee is **1.25%** (0.95 protocol / 0.30 creator) — the
  `Global` account's 95/5 is superseded by the `pump_fees` `FeeConfig`, and
  reading `Global` alone understates their creator share 6×. So pump pays
  creators the same 0.30% we do; we simply charge traders 1.00% where pump
  charges 1.25% and letsbonk 1.50%.
- **A 1% destination pool is conservative, not aggressive.** Meteora ships
  0.25/0.3/1/2/4/6% as first-class migration options, and one live letsbonk
  platform config graduates into a **2.0%** CPMM pool. Tier 1 sits below
  what the market already bears.
- **Our 90/10 split is more generous than the closest precedent.** Moonit —
  the most creator-friendly launchpad found — splits post-graduation fees
  **80/20**. We propose 90/10.
- **Holding the fee key in a program PDA is a real advantage, not a
  detail.** StonkFun's liquidity genuinely is locked (their position NFTs
  sit with Raydium's locker authority — verified on chain), but the *fee
  keys* are in platform bot wallets, so the creator's advertised 50% is an
  off-chain promise the platform could stop keeping. letsbonk mints the fee
  key to a platform wallet outright. Our fee-authority PDA can only ever pay
  the coin's creator, and no key exists that could redirect it.

## 2. The model

### Before graduation — unchanged, 1.00%
`0.70%` protocol / `0.30%` creator, fees on top of the curve price. No
change: we already match pump's creator share (0.30%) while charging
traders 1.00% against pump's 1.25% and letsbonk's 1.50%. Raising it would
throw away that position; lowering the protocol side is unnecessary (§3).

### At graduation — no fee at all
The full **85.005359 SOL raise becomes liquidity**. The
`0.215485 SOL` cost (0.15 Raydium create-pool + 0.042157 rent + 0.023328
lock) is paid from the coin's **own** accumulated protocol fees, which are
`0.595038 SOL` by the time a curve can complete — 2.76× cover, guaranteed
by arithmetic rather than hope.

pump charged ~6 SOL for this in the Raydium era against maybe 0.8 SOL of
real cost. We charge nothing. That is the headline claim of the product and
it costs us less than a third of what we already earned on the coin.

### After graduation — the locked LP stream, split 90 / 10 by value
Graduate into **Raydium AmmConfig index 1 (1.00%)**, not index 0 (0.25%).
Identical cost, 4× the perpetual income (§3 of the research doc). Raydium
keeps 16%; our locked position earns **0.840% of all volume, forever**.

Fees arrive in two tokens — roughly half wSOL, half the coin. Split them
differently, because they are not the same asset:

- **The coin side always goes 100% to the creator/DAO.** The protocol has
  no business accumulating memecoin dust it cannot sell without moving the
  price of the thing it is supposed to be neutral about.
- **The wSOL side repays the graduation, then splits 20 / 80.** Until the
  `0.215485 SOL` we fronted is recovered, 100% of the wSOL side comes to
  the protocol — about **51 SOL of cumulative volume**, typically the first
  hours. After that the protocol takes **20% of the wSOL side** and the
  creator/DAO takes the rest.

Steady state, as a share of all post-graduation fee value:

| | share | of volume |
|---|---|---|
| creator / DAO | **90%** | 0.756% |
| protocol | **10%** | 0.084% |

Which lands us next to pump (their protocol takes 0.05% of volume) while
paying the DAO 0.756% against pump's 0.95%-decaying-to-0.05%. Over a coin's
life we pay the creator **more** than pump does, because we never decay.

### What a trader pays

| | dao.fun | pump.fun | letsbonk |
|---|---|---|---|
| on the curve | **1.00%** | 1.25% | 1.50% |
| after graduation | **1.00%** flat | 1.20–1.25% early, 0.30% at scale | 2.00% (one live config) |

Cheapest on the curve, and cheaper than pump after graduation exactly when
a coin is young and most of its trading happens.

## 3. Why these numbers

**Why no graduation fee.** At 0.595 SOL of protocol revenue per completed
curve against 0.215 SOL of cost, a margin buys little and costs the one
claim nobody else can make. pump's 6 SOL was resented for years.

**Why 20% of the SOL side and not more.** The DAO treasury stream is the
product. Taking a visible bite out of it undercuts the pitch. 10% of total
fee value keeps us within sight of pump's 0.05% protocol take while leaving
the story intact: *your treasury keeps 90% of trading fees, forever.*

**Why recover the graduation cost first.** It makes "we pay for your
graduation" true rather than a subsidy we quietly claw back through a
permanently higher rate. 51 SOL of volume is noise for any coin that
graduates; for the rare coin that graduates and dies, we eat the loss,
which is the honest outcome of having promised to pay.

**Why tier 1 and not tier 6 (1.5%) or 3 (4%).** Our liquidity is locked and
cannot follow flow. Anyone may open a cheaper competing pool for the same
pair, and routers chase best execution. pump's own schedule — 1.20–1.25%
right after graduation, decaying to 0.30% — is the market's revealed
tolerance. A flat 1.00% sits inside it. Above that we invite an undercut we
could not answer.

## 3b. Considered and rejected

**Bill the cranker (Meteora's `flash_rent`).** A pre-funded PDA fronts the
rent so the CPIs get a PDA payer, then charges the external signer exactly
what was consumed. Elegant, and it keeps `migrate` permissionless on paper.
Rejected because it is only permissionless on paper: a stranger who cranks
is out 0.2 SOL for nothing, so in practice only the platform ever cranks,
and we would have taken on a liveness dependency for no benefit.

**Permission the crank (Raydium LaunchLab).** They guarantee funding by
requiring `migrate_to_cpswap_wallet` to sign. That is a clean answer for
someone who owns the venue and runs the keeper, but it means graduation
stops if their wallet stops. Our whole graduation story is that anyone can
finish it; the per-mint vault gets the same funding guarantee without
giving that up.

**An additive curve-phase creator fee (LaunchLab's `creator_fee_rate`,
capped at 0.5%).** Genuinely simpler than partitioning a locked LP
position — creator revenue never has to be negotiated against protocol
revenue. Rejected as a *replacement* because it stops at graduation, which
is exactly the problem we are solving. Our 0.30% curve creator fee already
is this mechanism; the locked-LP stream is what makes it perpetual.

**Splitting the fee-key NFT itself** (LaunchLab mints separate locked
positions for platform and creator). Doable, but it fixes the split
forever at migration time. Splitting the *collected* fees instead — which
G0 proved is possible, since recipients are unconstrained — leaves the
ratio a config value we can change without touching a locked position.

## 4. Implementation

Tests before code on every leg — this is the funds path.

- **F1 — Program (`launchpad-curve`).**
  - `Config` gains `lock_program` (zero ⇒ burn branch, keeps devnet
    working), `graduated_fee_protocol_bps` (default 2000 = 20% of the SOL
    side), and a mutable-but-validated `cpmm_amm_config` so the tier can
    move without a redeploy.
  - New PDA `["protocol-vault", mint]`. `buy`/`sell` route `protocol_fee`
    there instead of forwarding it to `fee_recipient` on every trade.
  - `BondingCurve` snapshots `amm_config` at creation (a config change must
    not re-price coins already in flight, exactly like fee bps today) and
    gains `fee_nft_mint`, `graduation_cost_lamports`,
    `graduated_sol_recovered`.
  - `migrate`: draw the overhead from the protocol vault, **fall back to
    the raise** if it cannot cover (Raydium's `create_pool_fee` is
    admin-mutable — never strand); lock the LP via `lock_cp_liquidity`
    when `lock_program` is set, else burn as today.
  - `collect_graduated_fees` — permissionless. CPIs `collect_cp_fees` into
    program-owned holding accounts, sends the coin side to the creator,
    and splits the wSOL side per the recovery rule above.
  - `collect_protocol_fee` — permissionless, destination fixed to
    `config.fee_recipient`, and while `!migrated` it must leave the
    projected graduation cost behind.
  - Config validation becomes the real invariant:
    `raise × protocol_fee_bps / 10_000 ≥ create_pool_fee + rent + lock`.
- **F2 — SDK.** Builders + decoders for all of the above; `raydium.ts`
  gains the tier table; pool derivation already ignores the AmmConfig
  (our `pool_state` is our own PDA), so nothing else moves.
- **F3 — Keeper.** Sweep graduated fees on a crank so treasuries accrue
  without anyone clicking; unwrap only the wSOL side.
- **F4 — App.** `/profile` and the coin page show graduated fees claimable
  and the recovery progress; the create page explains the model in one
  sentence.
- **F5 — Gates.** Layer 1 bankrun lifecycle (create → graduate + lock →
  swap → collect → split asserted to the lamport), devnet re-run of the
  burn branch, mainnet canary.

## 5. Open

- Competitor breadth (Meteora DBC, LaunchLab, Believe, Boop, Bags) is still
  being researched; if their platform take is materially above 10% of the
  post-graduation stream, revisit `graduated_fee_protocol_bps` — it is a
  config value precisely so this is a decision, not a redeploy.
- Fee-tier fragmentation at 1.00% is judgement, not measurement. If a
  competing 0.25% pool ever out-depths ours on a live coin, drop new
  launches to tier 5 (0.30%).
