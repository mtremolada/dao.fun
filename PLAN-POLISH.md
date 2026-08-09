# PLAN — make the programs perfect before public use

Operator directive (2026-08-09): *"do a huge audit and refactor what is
necessary and get this ready for live public use — everything perfect with no
bugs."* Staying on devnet for now.

A 15-agent adversarial audit (8 dimensions × refute-each × synthesize, workflow
`wf_504eab0b`) ran over the deployed programs and the SDK. It found **three**
confirmed bugs and refuted three others. Every survivor is in the
**migration/graduation path** — the one flow devnet cannot exercise, and so the
one the test suite proves only in bankrun. The curve math, the fee snapshot,
the account constraints elsewhere, the gate, and SDK↔program parity all held.

I re-verified all three against the actual source before trusting the agents.
What follows is my verification, not theirs.

---

## The three bugs, verified

### B1 — CRITICAL: migration bricked forever by a 0.002-SOL front-run

`programs/launchpad-curve/src/lib.rs:1748` and `:1755`. `migration_wsol` and
`migration_token` are declared `init` (not `init_if_needed`) as **associated
token accounts** of the `["migration-authority", mint]` PDA. An ATA address is
deterministic and **anyone can create it** via the ATA program for any owner.

Attack: a curve completes (`real_token → 0`, so `require!(!complete)` at :399
now blocks all sells — trading is closed). Before the keeper calls `migrate`,
an attacker spends ~0.00204 SOL to create `ATA(migration_authority, wSOL)`.
Now every `migrate` fails: Anchor's `init` CPIs the non-idempotent
`associated_token::create`, which hard-errors `AccountAlreadyInitialized`
before any migration logic runs. The curve is `complete` so trading can never
reopen, and `migrate` is the **only** path that moves the raise out of the sol
vault. **The entire raise (~85 SOL on production params) and every holder's
tokens are permanently locked.** Griefing cost: a few thousandths of a SOL.

This affects **devnet too** — same `init` ATAs on every cluster.

**Subtlety the audit's suggested `init_if_needed` fix misses.** `migrate`
closes `migration_token` at :701 via SPL `close_account`, which **requires a
zero balance**. An attacker who pre-creates AND pre-funds the coin-side ATA
with even one token unit makes that close revert — so `init_if_needed` alone
still bricks on the token side.

**Chosen fix — make them un-front-runnable, not merely tolerant.** Raydium
takes `creator_token_0/1` as plain non-signer metas (`:1314`), so they do
**not** have to be ATAs. Replace both with **program-PDA token accounts**
(`seeds = [MIGRATION_WSOL_SEED, mint]` / `[MIGRATION_TOKEN_SEED, mint]`,
`init`, `token::mint`, `token::authority = migration_authority`). An attacker
cannot create OR fund an account at a program-PDA address — only our program
can `invoke_signed` it into existence — so the entire class of front-run and
pre-fund attacks disappears, and `init` (not `init_if_needed`) stays correct.

**Open question, must verify first (bankrun, deployed CPMM binary):** does
Raydium's `initialize` accept a non-ATA token account as `creator_token_*`? It
takes them as plain metas, which strongly suggests yes, but the deployed
binary is the authority (D-031). A one-test spike settles it. If Raydium
*does* require an ATA, fall back to `init_if_needed` on the wSOL side and, for
the token side, drain-then-close (transfer any residual coin to the pool or
back to the curve) so a pre-funded balance cannot block the close.

### B2 — HIGH: the lock cost is never reserved; a permissionless sweep kills the fee stream

Mainnet only — devnet has no locker, so this branch never runs there. But it
breaks the flagship feature (the perpetual post-graduation fee stream) by
default on mainnet.

`collect_protocol_fee` (`:1008`) holds back a reserve of
`create_pool_fee + CPMM_RENT_LAMPORTS` **only while `!migrated`** (`:1014`).
Once migrated it sweeps the vault to the rent floor. But when `lock_program`
is set, the LP is left in `migration_lp` for a **separate** later instruction,
`lock_graduated_liquidity` (`:758`), which pays the locker (~0.038 SOL:
`locked_liquidity` rent + fee-NFT mint + metadata) **out of `protocol_vault`**
(`:803`, `:846`). Between `migrate` and that lock, anyone can call the
permissionless `collect_protocol_fee` — now `migrated == true`, so no reserve
— draining the vault. The lock then reverts for lack of funds, **forever**:
the LP sits migrated-but-unlocked, the `["graduated", mint]` record never
gets written, and the coin's creator/DAO fee stream is dead. No funds are
stolen (the vault residue is recoverable by refunding the PDA), but the
feature silently fails.

**Fix.** Two coordinated changes: (a) in `migrate`, when `locking`, add the
lock-branch cost to what the vault must retain — do not send it to the pool or
sweep it; (b) in `collect_protocol_fee`, hold back the lock cost while
`migrated && lock_program set && graduated-fee record absent`, i.e. while a
lock is pending. Introduce a `LOCK_COST_LAMPORTS` constant (measured in the G0
spike: 23,328,400 + NFT mint rent + metadata rent) and cross-check it against
the live cost in the lock instruction.

### B3 — MEDIUM: `graduation_fee` is read live, not snapshotted, and the floor ignores it

`migrate` reads `config.graduation_fee_lamports` **live** at `:483` and
subtracts it at `:499–503` via `checked_sub`, which underflows to
`GraduationUnderfunded` if the fee exceeds `real_sol − from_raise`. The
`BondingCurve` snapshots only the two bps fees at creation (`INV-FEE-SNAPSHOT`,
`:1501`), **not** the graduation fee, and `ConfigParams::validate` (`:1420`)
floors the raise at `2 × (pool fee + rent)` **without** adding
`graduation_fee_lamports` (bounded only by `MAX_GRADUATION_FEE_LAMPORTS = 5
SOL`).

Consequences: (a) an authority who raises `graduation_fee` via `update_config`
after coins exist **strands every already-completed coin** — a real
`INV-FEE-SNAPSHOT` violation the invariant's wording doesn't cover; (b) a
config that passes `validate` with the raise near the floor and a modest
graduation fee strands coins the moment they complete. On devnet
`graduation_fee_lamports == 0`, so nothing is triggerable today — this is a
robustness/correctness fix for any non-zero fee.

**Fix.** Snapshot `graduation_fee_lamports` onto `BondingCurve` at creation and
use the snapshot in `migrate`; and add it to the `validate` floor so a
completable curve can always afford graduation.

---

## What was refuted (recorded so it is not re-audited)

Three findings did not survive the refute pass: curve round-trip
"profitability" (fees + rounding always favor the curve), a claimed parity
drift in an event decoder (offsets matched), and a gate whitelist bypass (the
inner-program check already covers it). The curve/fee/gate cores are sound.

---

## Sequencing and the SOL constraint

All three fixes are **program changes** → one coordinated revision, one
redeploy. The SBF toolchain is present, so build + byte-verify + bankrun proof
against the real binaries cost **no SOL** and are the primary evidence anyway
(GATE L1/L3 rest on exactly that). The **devnet redeploy** needs a buffer of
~3.7 SOL; the deployer holds 2.22. So the loop is:

1. **Spike** the Raydium non-ATA question (bankrun, deployed CPMM). Decides B1's fix shape.
2. **Tests first** (doctrine: funds/PDAs). One failing bankrun test per bug:
   - B1: pre-create `ATA(migration_authority, wSOL)`, assert `migrate` still succeeds.
   - B2: migrate locking, then `collect_protocol_fee`, then assert `lock_graduated_liquidity` still succeeds.
   - B3: config with a non-zero graduation fee raised after creation; assert an already-completed coin still migrates.
3. **Implement** the three fixes; keep the config 277-byte layout stable (carve the graduation-fee snapshot from `BondingCurve`'s reserved space, not config's).
4. **Update** the SDK migrate builder, the keeper, and `devnet-audit`/`smoke` for B1's account change.
5. **Prove**: `cargo-build-sbf`, byte-verify the fresh `.so` against a regenerated fixture, full unit+integration suite green, `devnet-audit`/`smoke` still green against the *current* deploy.
6. **Commit + push**, marked "proven in bankrun, awaiting devnet redeploy."
7. **Redeploy** to devnet when the deployer is topped up (browser faucet to
   `5xqnc7on…`; this IP is faucet-blocked), then re-run `devnet-audit` and a
   fresh `--graduate` smoke to confirm B1 live.

**Nothing here is user-blocking to *build and prove*.** Only the final live
redeploy waits on SOL, and that is a single command once funded.

---

## STATUS (2026-08-09) — all three fixed and proven

All three bugs are fixed, each with a regression that is red on the old binary
and green on the new. Recorded in DECISIONS.md D-060.

- **B1** — migration ATAs → program PDAs. The open Raydium question is
  ANSWERED: both graduation tests pass on the rebuilt binary, so Raydium
  accepts the non-ATA `creator_token_*`. `init_if_needed` would have been
  insufficient (the token-side close needs a zero balance); the PDA approach
  defeats the pre-fund variant too.
- **B2** — `collect_protocol_fee` reserves `LOCK_RESERVE_LAMPORTS` while a lock
  is pending, via a new address-pinned `graduated_fees` marker account.
- **B3** — `graduation_fee_lamports` immutable after init + added to the
  `validate()` floor. No `BondingCurve` layout change, so the 11 live devnet
  coins still deserialize.

**Verification carried (no SOL):** toolchain reproduces the committed fixture
byte-for-byte; 522 unit+integration tests green against the real mainnet
binaries in bankrun; eslint/tsc clean.

**Left:** the live devnet redeploy — one command once the deployer is funded
(~3.7 SOL buffer vs 2.22 held). It is a COORDINATED program+SDK deploy: ship
both together, never a half-state (D-060).
