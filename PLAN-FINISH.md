# PLAN — finish every open item

Operator directive (2026-08-09): *"make a plan to finish all unfinished
items and implement them all"*.

Inventory taken by reading the code, not the notes — and one carried-over
note turned out to be false (F3 below). Ordered by whether the thing is
broken, invisible, or merely unrecorded.

---

## F1 — Wire the graduated-fee crank  ✅ DONE (559a37a)

`crankGraduatedFees` (packages/keeper/src/graduated-fees.ts) is tested and
exported and **nothing calls it**. Both post-graduation legs are
permissionless, which means they happen only if somebody bothers; the keeper
is that somebody. Until it is wired, a graduated coin's DAO accrues nothing
unless a human cranks by hand.

Wire it into the backend's keeper loop beside the migration crank, reading
`locked` from the presence of the `["graduated", mint]` record. Devnet has no
locker, so every tick there must settle as `not-ready` and stay quiet — that
is the behaviour to assert, or the logs become noise nobody reads.

## F2 — Make the fee stream visible (G3)  ✅ DONE

The mechanism works and is crankable, but nothing in the UI shows it. A
launcher cannot tell that their coin is earning.

- `app/lib/graduated.ts`: decode `GraduatedFees`, expose
  `{ locked, feeNftMint, costLamports, recoveredLamports, outstanding }`.
- `/profile`: on a graduated launch, show whether liquidity is **locked or
  burned** and the recovery progress — "graduation cost repaid" is the
  honest framing, not "fees earned", because until it is repaid the creator
  sees only the coin side.
- Coin page: same, plus a permissionless **Collect fees** button, since
  anyone may crank it and the destination is fixed on chain.
- Devnet shows the burn branch truthfully rather than pretending: no
  record, so the UI says liquidity was burned, not "locked".

Delivered on the coin page in 559a37a; `/profile` followed after, reading
every migrated launch in ONE `getMultipleAccounts` round (the public RPC
rate-limits per-call reads, and a rate-limited read would have rendered as
"burned" — the one wrong answer that matters). Both branches are pinned by
an e2e that seeds one coin with a `["graduated", mint]` record and one
without.

## F3 — Correct the guarded note, and route propose through the gate  ✅ DONE (559a37a)

**The carried-over note is wrong.** It says "dashboard/proposal screens
still build direct proposals — they must route via the gate builders". They
do not: `proposal-screen.tsx` only views and executes, there is no dashboard
screen, and the app has **no proposal-creation UI at all**. Nothing in the
app builds a direct proposal, so nothing there needs re-routing.

The real gap is one level down: `buildProposeIxs` is the production propose
path and has no guarded variant, so any caller proposing on a guarded realm
would bypass the gate and be refused by the fork's
`min_community_weight_to_create_proposal = u64::MAX` sentinel (D-042).

Add `buildGuardedProposeIxs` — same shape and same wrapping as
`buildProposeIxs`, but create/insert/sign-off go through the gate's CPIs so
the gate's validation engine runs first. Prove it against the deployed
GovER5 binary the way `guarded-gate-v2` already proves the pieces.

## F4 — Record what exists (GATES, REDTEAM, docs)  ✅ DONE (559a37a)

- GATES.md: an evidence row for the fee model — bankrun lifecycle, the
  devnet run with its transaction signatures, and what is still unproven.
- REDTEAM.md: the guarded row. Section 1 covers capture on open realms; the
  guarded front door changes who may author, so it needs its own analysis —
  including the honest residual that the gate program's upgrade authority
  is a capture path until it is revoked.
- PLAN-GRADUATED-FEES / PLAN-FEE-MODEL: mark the shipped phases.

## F5 — The flaky integration suite  ✅ ROOT-CAUSED + SURVIVABLE (D-051)

Reproduced, caught live, and traced to a **use-after-free in solana-bankrun**:

```
thread 'tokio-runtime-worker' panicked at solana-program-test-1.18.0:716
Program file data not available for `"̌\r\0\0\0\0\x91ϥ…  (DaV3yst…)
```

The program NAME is freed heap memory (the id beside it is intact), so
solana-program-test panics looking for a file by that garbage name — and the
panic kills the tokio task without settling the napi promise, leaving the JS
`await` on `start()` unable to ever resume. Every wedged run contains that
panic; every green run contains none. Not CPU contention, not memory, and not
reproducible by hammering `start()` alone.

My earlier attribution — my own test standing up a third runtime in one file
— was wrong: with that fixed the next wedge landed in `gate0b-token2022`,
which I had not touched.

The bug is upstream. The harness now (1) races every bankrun call against a
60s watchdog, so a wedge fails NAMING THE CALL instead of stalling 300s and
orphaning workers, and (2) retries context creation exactly once. Measured
over six verification runs: two wedged, both retried, **all six finished
20/20 green**. Also fixed in passing: fixture inflation was a TOCTOU that
could hand bankrun a half-written ELF on a fresh clone (now temp file +
atomic rename).

Not claimed: that the wedge is gone. It is upstream and unfixed — we route
around it, noisily, and the label the watchdog prints is what a bug report to
solana-bankrun would need.

## F6 — Operator-gated, NOT doable here

- **GATE L4 mainnet canary.** The lock path can never run on devnet
  (Raydium's locker is absent and hard-codes the mainnet CPMM id), so the
  only true end-to-end is one real mainnet launch. It spends real SOL and is
  a go/no-go the operator makes, not me.
- **Devnet gate deploy** for live guarded evidence (~2 SOL of the 4.1 left).
  Worth doing only if live evidence is wanted; bankrun already proves the
  gate against the real binary.

## F7 — Red-team the fee model (added after the inventory)

The inventory missed it: REDTEAM.md covered capture, execution fidelity,
custody, distribute and guarded mode, but had NOT a single row on the fee
model — which added a permissionless value-moving instruction, a PDA holding
a fee-key NFT, and a per-mint vault. Now §4c, eight rows, each asking what a
stranger gains by calling it, plus the two residuals stated plainly (our
upgrade authority is the trust anchor; the lock path cannot be proven on
devnet at all).
