# How graduation should be funded and priced when you DON'T own the DEX

Operator question (2026-08-09): *"we do not own the dex we are migrating to
so it would work more like when pump was migrating to raydium — how should
we do it?"*

Correct framing, and it changes the answer. pump.fun's **current** model is
not our analogue: since PumpSwap they migrate into their own AMM, so their
graduation costs 0.0082 SOL of rent and nothing else. We pay a third party
0.15 SOL for a pool we will never control. The comparable era is
pump-on-Raydium, and the comparable question is the one every launchpad
that rents its venue has to answer:

> The raise is finite, the venue charges rent, and the fee stream after
> graduation belongs to whoever holds the LP. Who pays, how much do we
> charge on top, and what do we keep?

Everything below marked **[measured]** was driven against the deployed
binaries in bankrun or read from live mainnet state. Nothing is quoted from
a blog post.

---

## 1. The measured baseline

**Our curve** (`PUMP_CLASSIC`, identical shape to pump's): raise at
completion **85.005359 SOL**, curve fee **1.00%** split 0.70 protocol /
0.30 creator → **0.595038 SOL** of protocol fee per completed curve.
[measured — `curve-math.ts`, program `Config`]

**Our graduation cost**: 0.150000 create-pool fee + 0.042157 rent
= 0.192157 SOL today, plus **0.023328 SOL** for the Burn & Earn lock
(D-049) = **0.215485 SOL**. [measured — G0 +
`launchpad-cpmm-verify.integration.test.ts`]

**pump.fun today**, driven end to end on their binaries
(`pump-migration-economics.integration.test.ts`):

```
raise at completion         85.005359057 SOL
pool_migration_fee charged   0.015000001 SOL   ← against the RAISE
  of which pool rent         0.008171040 SOL
  net kept by pump           0.006828961 SOL
seeded into the pool        84.990359056 SOL
paid by the cranker          0.000000000 SOL
```

Two facts to carry forward. **The raise funds graduation** — not pump's
protocol revenue. And `migrate_v2`'s only signer is `user`: anyone may
crank it and the caller pays nothing but a signature, so graduation can
never stall for want of funding. That liveness property is the real prize,
and it is why "the raise pays" keeps winning.

**pump's curve split is 0.95% protocol / 0.05% creator** [measured — live
`Global`]. Same 1% headline as ours; they keep **19×** what the creator
does, we keep 2.3×.

## 2. The thing that actually matters: what happens AFTER graduation

PumpSwap's fee is **market-cap tiered and creator-weighted** [measured —
live `amm-fee-config`]:

| Market cap | LP | protocol | **creator** | total |
|---|---|---|---|---|
| < 420 SOL | 0.02% | 0.93% | 0.30% | 1.25% |
| 420 – 1,470 SOL | 0.20% | 0.05% | **0.95%** | 1.20% |
| 4,420 SOL | 0.20% | 0.05% | 0.75% | 1.00% |
| 24,560 SOL | 0.20% | 0.05% | 0.55% | 0.80% |
| ≥ 98,240 SOL | 0.20% | 0.05% | 0.05% | 0.30% |

A graduated coin lands at **~411 SOL market cap** (pool SOL ÷ 206.9M
tokens × 1B supply) — i.e. one good candle above the 420 SOL boundary
[measured]. So in practice **pump pays a freshly graduated coin's creator
0.95% of every lamport of volume**, decaying as the coin grows.

That is the bar. Our plan as written pays the DAO the **LP** share of a
0.25% Raydium pool = **0.21%** of volume. We would be **4.5× worse than
pump** at the moment that matters most.

We cannot answer with a creator fee: Raydium CPMM has no such concept — its
`AmmConfig` carries only trade/protocol/fund/create-pool fields
[measured]. The LP share is our only lever.

## 3. The lever nobody was using: Raydium has eight fee tiers

Every one of them is enabled, and **every one costs the same 0.15 SOL to
create a pool in** [measured, live mainnet]:

| idx | AmmConfig | trade fee | to our locked LP | volume to repay 0.2155 SOL |
|---|---|---|---|---|
| 0 | `D4FPEru…` | 0.25% | 0.210% | 103 SOL |
| 5 | `BgxH5if…` | 0.30% | 0.252% | 86 SOL |
| 4 | `BhH6Hph…` | 0.50% | 0.420% | 51 SOL |
| **1** | **`G95xxie…`** | **1.00%** | **0.840%** | **26 SOL** |
| 6 | `B5u5x9S…` | 1.50% | 1.260% | 17 SOL |
| 2 | `2fGXL8u…` | 2.00% | 1.680% | 13 SOL |
| 7 | `ESLj2Rz…` | 2.50% | 2.100% | 10 SOL |
| 3 | `C7Cx2pM…` | 4.00% | 3.360% | 6 SOL |

(Raydium keeps 16% of the trade fee — 12% protocol + 4% fund — across all
tiers; the locked position gets the other 84%.)

**Tier 1 (1.00%) gives the DAO 0.840% of volume — within 12% of what pump
pays a freshly graduated creator, at identical cost.** Choosing tier 0 out
of habit is leaving 4× the DAO's perpetual income on the table.

The pool address does **not** depend on the AmmConfig — our `pool_state` is
our own PDA (`poolStatePda(mint)`), the unsquattable derivation from D-034 —
so changing tier changes no derived address anywhere. It is a pure config
choice.

**Why not tier 3 (4%)?** Fragmentation. Anyone can open a competing CPMM
pool for the same pair at a lower tier, and routers send flow to best
execution. Our liquidity is locked forever and cannot follow. pump's own
schedule is the sanity check: they charge 1.20–1.25% right after graduation
and decay toward 0.30% as the coin matures. A single fixed 1.00% sits
inside that envelope — aggressive early, generous later — and is a normal
tier for volatile pairs. 2%+ invites someone to undercut us.

The real limitation: **Raydium's tier is fixed at pool creation and a
locked pool cannot be re-tiered.** We pick once, for the life of the coin.
That argues for a middle value rather than an extreme.

## 4. Who funds it — three models

| | pool seed | protocol per coin | liveness risk |
|---|---|---|---|
| **A** cost from the raise (today) | 84.789874 | +0.595038 | none — self-funding |
| **B** fixed fee w/ margin (pump-on-Raydium) | 84.505359 @0.5 SOL | +0.879552 | none |
| **C** per-mint protocol-fee vault | **85.005359** | +0.379552 | none, if per-mint |

**A** is what we and pump both do. **B** is what pump did on Raydium: a
fixed fee comfortably above cost, keeping the surplus — that was the famous
6 SOL, against maybe 0.8 SOL of real cost.

**C** is the operator's proposal, and it survives scrutiny *provided the
vault is per-mint*: route `protocol_fee` to `["protocol-vault", mint]`
instead of forwarding it to an external wallet on every trade. Then
graduation is funded by **that coin's own protocol fees**, already
collected before the curve could complete. Not a subsidy — earmarking. And
sufficiency is arithmetic, not hope:

```
raise × protocol_fee_bps / 10_000  ≥  create_pool_fee + rent + lock_cost
      0.595038                     ≥            0.215485          ✓ 2.76×
```

which slots into the existing `INV-GRAD-COVERS-COST` config check and is
strictly stronger than today's `raise ≥ 2 × (0.15 + rent)` — it also
catches an operator setting `protocol_fee_bps` too low.

A **global** vault would be a different story: permissionless `migrate`
would depend on someone keeping it topped up, and a drained vault strands
holders' SOL in a completed curve. Per-mint has no such dependency.

**Headroom against Raydium raising `create_pool_fee`** (it is
admin-mutable, which is why `migrate` reads it live): model A tolerates
almost anything; model C breaks above **0.5296 SOL**. Cheap fix: draw from
the protocol vault, and fall back to deducting the shortfall from the raise.
Never-strand stays absolute.

## 5. Recommendation

1. **Fund from the per-mint protocol vault, with fallback to the raise
   (model C).** 100% of the raise becomes liquidity — a claim no competitor
   can make, worth more in trust than the 0.215 SOL it costs. The fallback
   keeps the never-strand invariant that makes permissionless `migrate`
   safe.
2. **Graduate into AmmConfig index 1 (1.00%), not index 0.** Same cost, 4×
   the DAO's perpetual income, and still inside the envelope pump's own
   fee schedule says the market bears. Store it in `Config`, snapshot it
   onto the curve at creation the way fees already are, so a config change
   cannot re-price coins already in flight.
3. **Charge no margin at graduation.** pump's 6 SOL was rightly resented,
   and we do not need it: 0.595 SOL of protocol fee per coin against 0.215
   SOL of cost is already 2.76× coverage.
4. **Take a protocol share of the post-graduation stream — 10–20%, set in
   `Config`, default 0 until the operator picks.** This is the only
   recurring revenue the design otherwise has, and it is what makes a
   graduated coin genuinely pay for itself: at tier 1 and a 20% share, the
   0.215 SOL outlay is repaid by **26 SOL** of cumulative volume. G0 proved
   recipients are unconstrained, so `collect_graduated_fees` can split
   without asking anyone's permission.

Net position per graduated coin under the recommendation: protocol earns
0.595 up front, spends 0.215, and then earns 0.168% of all volume forever
(20% of 0.840%); the DAO earns 0.672% of all volume forever; and every
lamport of the raise is in the pool, locked, unwithdrawable by anyone.

## 6. Open items

- The 8 fee tiers were read live today; `create_pool_fee` is uniform at
  0.15 SOL across all of them. Re-check before mainnet — Raydium's admin
  can change any of it, which is exactly why `migrate` reads it live.
- Fragmentation risk at tier 1 is a judgement call, not a measurement. If a
  competing 0.25% pool ever out-depths ours on a live coin, that is the
  signal to drop new launches to tier 5 (0.30%).
- Half the fee stream arrives as the coin, not SOL. Selling it is a DAO
  governance question; the keeper should only unwrap the wSOL side.
