# SPEC-LAUNCHPAD.md — native bonding-curve launchpad

**Version:** 1.0 (2026-08-08). Authoritative for the launchpad subsystem.
**Relationship to SPEC.md:** SPEC.md v2.x remains authoritative for the DAO
product (governance, custody, the action menu) and is operator-signed; this
sibling spec owns the launchpad and is referenced from SPEC.md §14. Where
the two touch — a coin launched with the DAO toggle — SPEC.md's invariants
(INV-1, INV-2, INV-5, INV-7, INV-8) bind unchanged.
**Doctrine:** identical to SPEC.md §0. Contract first, then the failing
test, then the code. Anything touching funds or PDAs is tested before it is
written. Deployed binaries outrank source repos as evidence.

## 0. What this subsystem is

A pump.fun-class launchpad running on our own curve:

- anyone launches a coin in one transaction (optionally with a dev-buy),
- the coin trades on a constant-product curve with virtual reserves until
  it has raised the graduation threshold,
- graduation is permissionless: the curve's liquidity seeds a **Raydium
  CPMM** pool and the LP tokens are **burned**,
- a board page shows what is new, what is close to graduating, and what
  has graduated,
- a launcher may opt in to "launch as DAO", which makes the coin's creator
  the Squads vault of a new Realms DAO — the existing product, entered
  through the new front door.

**Non-goals for v1.0** (each is a deliberate omission, not an oversight):
structural anti-snipe mechanics; comments, profiles, or livestreams; our
own AMM; LP locking via Raydium Burn & Earn (the operator chose burn);
Token-2022 coins; non-SOL quote assets.

## 1. Economics

### 1.1 Profiles

Two named parameter sets. Both live in the config PDA; the code path is
identical and only the numbers differ.

| Parameter | `pump-classic` (production) | `devnet-scaled` (GATE L2) |
|---|---|---|
| `token_total_supply` | 1,000,000,000,000,000 (1B @ 6dp) | same |
| `initial_virtual_sol` | 30,000,000,000 (30 SOL) | 1,000,000,000 (1 SOL) |
| `initial_virtual_token` | 1,073,000,000,000,000 | same |
| `initial_real_token` (sellable) | 793,100,000,000,000 | same |
| reserved for the pool | 206,900,000,000,000 (206.9M) | same |
| completion raise | **85,005,359,057** lamports | **2,833,511,969** lamports |

Completion raise is derived, never configured:
`raise = initial_virtual_sol * initial_real_token / (initial_virtual_token - initial_real_token)`.

`devnet-scaled` exists because completing a full curve costs ~85 SOL and
the devnet faucet yields 2–5 SOL per cycle (D-033). Devnet evidence is
evidence about *code paths*, not about production economics.

### 1.2 Fees

Total trade fee **100 bps**, split **70 protocol / 30 creator**, snapshotted
onto each curve at creation.

- Enforced band: total ∈ [10, 500] bps, checked on every path that can set
  it. A zero-fee path makes wash trading free (the Meteora `cliff_fee = 0`
  audit finding); a runaway ceiling is an authority-key rug vector.
- **Buy**: fee is charged **on top** of the curve cost. The net curve cost
  enters both SOL reserves; the fee never does.
- **Sell**: fee is taken **off gross proceeds**, ceil-rounded, clamped at
  zero so dust sells cannot underflow.
- Protocol fee transfers to `config.fee_recipient` at trade time. Creator
  fee accrues in a per-creator vault, aggregated across that creator's
  coins, and is swept by a **permissionless** instruction that can only pay
  the stored creator.

### 1.3 Graduation accounting

At completion the curve holds its raise in a program-owned SOL vault and
206.9M tokens in its token vault. Migration spends, from that vault:

| Item | Lamports |
|---|---|
| `AmmConfig.create_pool_fee` | read at runtime (150,000,000 today) |
| Rent for the six accounts CPMM initializes | 42,156,720 |
| `config.graduation_fee_lamports` | 0 by default, capped at 5 SOL |

Measured, not estimated: fee + rent = **192,156,720** lamports
(`tests/launchpad-cpmm-verify.integration.test.ts`). Everything left over,
plus the full reserved token balance, seeds the pool. Reclaimed rent from
temporary accounts and any graduation fee go to `config.fee_recipient`.

`initialize_config` refuses a parameter set whose completion raise is less
than twice the migration overhead (**INV-GRAD-COVERS-COST**) — a curve that
cannot afford to graduate must never accept a deposit.

## 2. Program contract (`programs/launchpad-curve`)

### 2.1 Accounts

| Account | Seeds | Owner | Notes |
|---|---|---|---|
| `Config` | `["config"]` | program | global; CPMM addresses immutable after init |
| `BondingCurve` | `["bonding-curve", mint]` | program | reserves, fee snapshot, `complete`, `migrated` |
| SOL vault | `["sol-vault", mint]` | system | data-less; holds the raise |
| token vault | ATA(curve PDA, mint) | token program | holds unsold + reserved supply |
| creator vault | `["creator-vault", creator]` | system | aggregated across the creator's coins |
| migration authority | `["migration-authority", mint]` | system | must be system-owned: CPMM pays fee+rent via `system_instruction::transfer` from `creator` |
| pool state | `["cpmm-pool", mint]` | CPMM after init | signed by us via `invoke_signed` (D-033 A8) |

### 2.2 Instructions

- `initialize_config(params)` — once. Sets fees (band-checked), curve
  initials (INV-GRAD-COVERS-COST), `fee_recipient`, authority, and the
  three CPMM addresses. **CPMM addresses can never be changed afterwards.**
- `update_config(...)` — authority only. May change fees (band-checked,
  future coins only), `fee_recipient`, graduation fee, curve initials for
  future coins, and hand over authority. **Refuses any CPMM address.**
- `create_coin(name, symbol, uri, creator)` — mint is a fresh client
  keypair signer; 6 decimals; freeze authority `None` from birth; full
  supply minted to the curve's token vault; Metaplex metadata created
  immutable; mint authority set to `None` before the instruction ends.
  `creator` is an **argument, never a signer** (INV-CREATOR-ARG) — that is
  what lets a Squads vault PDA be the creator.
- `buy(token_amount, max_sol_cost)` — exact-token-out; output clamped to
  remaining real reserves; the clamping buy sets `complete = true`.
  **One buy instruction, no variants** (the Meteora `swap2` bypass).
- `sell(token_amount, min_sol_output)` — refused once `complete`.
- `migrate()` — **permissionless, idempotent**, requires
  `complete && !migrated`. Wraps the pool's SOL side, CPIs CPMM
  `initialize` signing two PDAs, **burns the entire LP balance**, closes
  temporary accounts, records `pool_state`, sets `migrated`.
- `collect_creator_fee()` — permissionless to crank; pays only the stored
  creator; leaves the vault at its rent floor.

**There is no withdraw instruction, at any privilege level.** This absence
is the security design (D-033), not an omission to be corrected later.

All four state transitions emit `emit_cpi!` events — `CreateEvent`,
`TradeEvent` (carrying post-trade reserves so the indexer needs no math),
`CompleteEvent`, `MigrateEvent` — because plain logs are truncatable and
the indexer is downstream of them.

## 3. Invariants

Each maps to at least one named assertion. Curve-math invariants are
property-tested over the TypeScript reference implementation and re-checked
on-chain by the parity suite; structural ones are refused-transaction tests
against real binaries.

**Curve math.** INV-ROUND-BUY, INV-ROUND-SELL (floor division; the pool
keeps dust on both sides) · INV-ROUNDTRIP-NONPROFIT
(`sol_out(sell(tokens_out(buy(x)))) <= x` for all x) · INV-K-NONDECREASING ·
INV-U128-WIDEN (every `amount * reserve` widens before narrowing) ·
INV-RESERVE-CAP (buy output clamped to real reserves, cost reconciled) ·
INV-SOL-CONSERVATION (vault lamports equal accounted reserves after every
instruction) · INV-COMPLETE-MONOTONE (one-way; trading refused after) ·
INV-MONOTONIC-PRICE · INV-SELL-NO-UNDERFLOW.

**Fees and slippage.** INV-SLIPPAGE-BUY / INV-SLIPPAGE-SELL (checked after
fee and curve) · INV-FEE-FLOOR · INV-FEE-CAP · INV-FEE-SNAPSHOT (a config
change cannot retax a live curve).

**Structural.** INV-VAULT-PDA-ONLY (no key can move principal) ·
INV-CREATOR-ARG · INV-MINT-MATCH (every token account's mint matches the
curve's — the Raydium June-2026 fake-mint class) · INV-HAS-ONE ·
INV-NO-REINIT · INV-NO-REVIVAL · INV-CPI-PINNED (CPMM addresses from config,
substitutes refused) · INV-RENT-EXEMPT · INV-NO-ORACLE (price is a pure
function of internal reserves).

**Graduation.** INV-GRAD-COVERS-COST · **INV-LP-BURNED** — after migration
the migration authority holds zero LP and `lp_mint.supply == 0`. Note the
measured subtlety (D-034): Raydium's 100 withheld LP units are never
minted, so a fully burned pool reads 0, not 100.

## 4. Component contracts

- **SDK** — `curve-math.ts` (pure bigint, browser-safe; **this module is the
  operation-order specification the Rust implementation mirrors**),
  `launchpad/{constants,instructions,events}.ts` (hand-rolled builders, no
  anchor TS client), `rails/native.ts` implementing the existing
  `LaunchRail`.
- **Backend** — a polling indexer (`getSignaturesForAddress` from a
  persisted cursor, decoding `emit_cpi` inner-instruction data), a
  `node:sqlite` store (coins, trades, cursor; candles aggregated at read
  time), REST routes for the board, coin, trades, candles and holders, an
  SSE stream for live updates, and a metadata endpoint. Public-RPC
  websockets and `getProgramAccounts` are hostile from this network (D-026),
  so the transaction source is an injected seam.
- **Keeper** — cranks `migrate` for completed curves and
  `collect_creator_fee` for DAO vaults. Fee payer only; never an authority.
- **Frontend** — `/board` (new / about-to-graduate ≥75% / recently
  graduated) and `/coin?mint=…` (chart, buy/sell panel quoting from
  `curve-math`, progress bar, live trades, holders, safety badges).
  Transactions stay client-built and wallet-signed; the backend is a read
  path only, so trading survives the API being down.

## 5. Gates

- **GATE L1 (hermetic).** Every invariant above cites a passing assertion;
  full lifecycle against the real CPMM and Metaplex binaries with exact
  balance assertions; both mint orderings; the DAO-toggle leg; TS/on-chain
  parity exact; CU within 85% of the 400k limit; REDTEAM.md updated.
- **GATE L2 (devnet).** Deploy, initialize, and run the whole flow live
  against Raydium's devnet CPMM, ending in a real pool with burned LP; the
  real indexer decodes every event from real transactions (the one thing
  bankrun cannot prove, since it has no `getTransaction`).
- **GATE L3 (mainnet).** Operator go/no-go: funding, a multisig upgrade
  authority, and the production fee recipient. No agent action.
