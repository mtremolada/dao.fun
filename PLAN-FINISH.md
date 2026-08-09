# PLAN — finish every open item

Operator directive (2026-08-09): *"make a plan to finish all unfinished
items and implement them all"*.

Inventory taken by reading the code, not the notes — and one carried-over
note turned out to be false (F3 below). Ordered by whether the thing is
broken, invisible, or merely unrecorded.

---

## F1 — Wire the graduated-fee crank  ⟵ a gap I created

`crankGraduatedFees` (packages/keeper/src/graduated-fees.ts) is tested and
exported and **nothing calls it**. Both post-graduation legs are
permissionless, which means they happen only if somebody bothers; the keeper
is that somebody. Until it is wired, a graduated coin's DAO accrues nothing
unless a human cranks by hand.

Wire it into the backend's keeper loop beside the migration crank, reading
`locked` from the presence of the `["graduated", mint]` record. Devnet has no
locker, so every tick there must settle as `not-ready` and stay quiet — that
is the behaviour to assert, or the logs become noise nobody reads.

## F2 — Make the fee stream visible (G3)

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

## F3 — Correct the guarded note, and route propose through the gate

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

## F4 — Record what exists (GATES, REDTEAM, docs)

- GATES.md: an evidence row for the fee model — bankrun lifecycle, the
  devnet run with its transaction signatures, and what is still unproven.
- REDTEAM.md: the guarded row. Section 1 covers capture on open realms; the
  guarded front door changes who may author, so it needs its own analysis —
  including the honest residual that the gate program's upgrade authority
  is a capture path until it is revoked.
- PLAN-GRADUATED-FEES / PLAN-FEE-MODEL: mark the shipped phases.

## F5 — The flaky integration suite

Two failures in one back-to-back triple run that I could not reproduce or
attribute, on a suite that is otherwise green. Capping the fork pool reduced
it; "reduced" is not "fixed" and a suite you re-run on red is a suite you
stop reading. Reproduce it under load with full output retained, then fix
the cause rather than the symptom.

## F6 — Operator-gated, NOT doable here

- **GATE L4 mainnet canary.** The lock path can never run on devnet
  (Raydium's locker is absent and hard-codes the mainnet CPMM id), so the
  only true end-to-end is one real mainnet launch. It spends real SOL and is
  a go/no-go the operator makes, not me.
- **Devnet gate deploy** for live guarded evidence (~2 SOL of the 4.1 left).
  Worth doing only if live evidence is wanted; bankrun already proves the
  gate against the real binary.
