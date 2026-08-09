# PLAN — finish everything devnet can actually finish

Operator directive (2026-08-09): *"Whatever is left to do on devnet — let's
finish that now."*

LAUNCH.md is the full pre-launch list. This is the subset of it that can be
**completed and proven without mainnet SOL and without an operator decision**,
in execution order. Everything else is named at the bottom so the boundary is
explicit rather than implied.

The test is not "did I write code" — it is **can devnet, or a hermetic
harness, show the thing working**. Each item below names that proof.

---

## D1 — Close GATE L5 for real: finalize AND execute, live

**Why it is open.** The live guarded run stops at a cast vote because the
production params are a 3-day window and a 72-hour hold-up, and a cluster's
clock cannot be warped. So the last two legs of the lifecycle — the vote
being *finalized*, and the proposal's instruction actually *executing* — have
never run on a real cluster. They are the legs where the gate hands control
back to ordinary governance, which is exactly where a wrong assumption would
hide.

**What I will do instead of waiting.** Run the SAME production ceremony
against a second realm whose governance carries a short window and a short
hold-up (`--fast`), then drive it all the way: propose through the gate →
vote → finalize → wait out the hold-up → execute, and verify the executed
instruction's effect on chain (lamports actually moved out of the DAO
treasury).

Changing only `baseVotingTime` and `minInstructionHoldUpTime` is honest: they
are governance *config*, not gate logic. Every account, every builder, every
CPI and the deployed gate binary are identical to the production path. A
non-zero hold-up is deliberate — zero would skip the check rather than prove
it.

| # | Item |
|---|---|
| D1.1 | Extract the advance logic (finalize / hold-up / execute) into a module both scripts share, so the fast run and the real one cannot drift. |
| D1.2 | `--fast` on `devnet-guarded-run.ts`: short window, short non-zero hold-up, treasury funded so the executed transfer is real. |
| D1.3 | Run it live. Assert: finalize moves Voting → Succeeded; execute is REFUSED during hold-up; execute succeeds after it; treasury lamports actually moved; state → Completed. |
| D1.4 | The production-params proposal (`vfwHWft…`) still finishes on its own clock in ~70h — D1 does not replace it, it de-risks it. |

**DONE (2026-08-09).** Every leg passed; signatures in GATES.md. The treasury
moved exactly the 1,000 lamports the proposal named, and the hold-up refused
an early execution rather than merely being configured.

---

## D2 — L-30 Dynamic priority fee (**BLOCKING** in LAUNCH.md)

`ConstantFeeEstimator` returns a flat 10,000 µlamports. It overpays on a quiet
chain and fails to land exactly when a launch is hot — a trade that does not
land is the product failing, which is why LAUNCH.md marks it blocking.

| # | Item |
|---|---|
| D2.1 | `RecentFeeEstimator`: sample `getRecentPrioritizationFees` for the accounts the transaction actually **writes**, take a high percentile, clamp to a floor AND a ceiling, cache for a few seconds so a burst of quotes is one RPC. |
| D2.2 | Escalate on retry — a rebroadcast at the same price is a rebroadcast that loses again. Must not break the "same signed bytes" rule that stops a retry becoming a duplicate trade: escalation applies to a NEW attempt, not to an in-flight one. |
| D2.3 | Show the fee in the confirm UI. Spending a user's money on urgency without telling them is not a trading app they will trust. |
| D2.4 | Fall back to the constant when the RPC does not support the method or returns nothing. |

**Proof:** unit tests replaying recorded congestion — including the ceiling
holding against a fee spike, the floor holding on a dead-quiet chain, and the
fallback — plus a live devnet sample showing the estimator returns a sane
number against a real RPC.

---

## D3 — L-60 metrics + L-63 abuse caps (**BLOCKING**)

Without numbers the failure mode is "users say it feels broken" and nothing to
look at. Without caps, one client can take the SSE fan-out down for everyone.

| # | Item |
|---|---|
| D3.1 | **Indexer lag in slots** — the single number that says the feed is behind — plus SSE client count, events/s, RPC calls/min and error rate, on a `/metrics` endpoint. |
| D3.2 | Per-IP SSE connection cap. `maxClients` today is global, so one client opening 1,000 connections is a complete denial of service against every other viewer. |
| D3.3 | Body-size limit on every writing endpoint; method allowlist on the RPC proxy. |
| D3.4 | Keeper balance in the metrics, so "graduations silently stopped" is visible before a user reports it. |

**Proof:** unit tests for each limit (the 1,001st connection from one IP is
refused while a different IP still connects; an oversized body is rejected; a
non-allowlisted RPC method is refused), and a live devnet run of the backend
showing lag near zero.

---

## D4 — L-42 / L-43 the client must actually stop hitting the RPC

The board already skips the chain-direct live path when the API is configured.
The coin screen does **not**: `watchTrades` runs chain-direct regardless, so
the per-user RPC cost survives exactly the change that was supposed to remove
it. And the degraded state has to be visible, or an API outage looks like a
dead site.

| # | Item |
|---|---|
| D4.1 | With the API configured, no screen scans or subscribes to the RPC for READS. Signing and sending stay client-side — that is the part that must never centralise. |
| D4.2 | An API failure falls back to chain-direct and says so, rather than showing an empty page. |

**Proof:** tests that assert the RPC is not touched when the API is
configured, and that a failing API produces the degraded state rather than an
error screen. Verified live against the backend running on devnet.

---

## D5 — L-31 coalescing + L-32 reconnect with a cursor (**BLOCKING**)

| # | Item |
|---|---|
| D5.1 | Batch incoming events into one state commit per animation frame. One trade or fifty in a frame should cost one render. |
| D5.2 | SSE reconnect with exponential backoff **and jitter** — without jitter every client reconnects on the same tick and the herd takes the server down again. |
| D5.3 | Resume from a cursor so a reconnect BACKFILLS instead of silently skipping. A gap here is invisible: the tape just quietly misses trades. |

**Proof:** a synthetic feed at 50 events/s asserting render counts, and a
reconnect test asserting no event is lost across a drop.

---

## D6 — The rest of what devnet can close

| # | Item |
|---|---|
| D6.1 | **L-91** indexer fetches transactions serially inside the tick loop. Batch them concurrently; the cursor already tolerates it (it applies in slot order and advances only over what applied), which is what makes this safe. |
| D6.2 | **L-26** `devnet-audit.ts` grows a `--cluster` flag so the mainnet audit is a flag on a proven script, not a script written under launch pressure. |
| D6.3 | **L-13** write down, in-product, what a user is trusting: who can upgrade, who holds config authority, what they can change. |
| D6.4 | **L-33** throttle hidden tabs; **L-36** skeletons and explicit error states on chain-reading screens. |

---

## What devnet CANNOT close, and why

Naming these so "finished on devnet" is not mistaken for "ready to launch":

- **L-01..L-07** — operator decisions (upgrade authority, RPC, hosting, peak,
  fee recipient, keeper funding, curve profile).
- **L-10..L-12** — authority policy: needs mainnet keys, and is irreversible.
- **L-20..L-26** — mainnet deploys: needs mainnet SOL. (L-26's *code* lands
  here; the run does not.)
- **L-40/L-41/L-46** — provisioning, domain, TLS: an account and a card.
- **L-50..L-52 (GATE L4)** — the mainnet canary. Raydium's locker is absent
  from devnet and hard-codes the mainnet CPMM id, so **the lock path can never
  run on devnet**. No amount of work here substitutes for it.
- **L-61** — alert *delivery* needs a destination (email/Slack/pager); the
  metrics it fires on are D3.
- **L-92** — Postgres + split nodes: threshold-gated at ~5,000 concurrent.

---

## Verification for the whole plan

1. `pnpm test` (unit + integration), `pnpm lint`, `tsc`, e2e — all green.
2. `pnpm tsx scripts/devnet-audit.ts` — exit 0.
3. `pnpm tsx scripts/devnet-smoke.ts` — exit 0 against the deployed binary.
4. D1 executed live, signatures recorded in GATES.md.
5. LAUNCH.md items ticked with what proved them; DECISIONS.md gets the
   decisions; PROGRESS.md updated.
