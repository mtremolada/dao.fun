# LAUNCH — everything unfinished, in the order it has to happen

Operator directive (2026-08-09): *"make this into a plan to go live with all
unfinished things and we will run the plan before launch."*

This is the single list. Anything not in here is either done and recorded in
GATES.md, or it is not blocking launch. Items are numbered `L-nn` so they can
be referenced in commits and sign-offs.

**How to read it.**

- **BLOCKING** — mainnet does not open until this is done and verified.
- **Owner: me** — I can do it in this repo.
- **Owner: operator** — needs a key, money, an account, or a judgement call
  that is not mine to make.
- Every item has a **verification**: the thing you look at to believe it. An
  item with no verification is not done, it is hoped.

**The order is not arbitrary.** §1 is irreversible and changes what every
later step means. §2 cannot start until §1's decisions are made. §5 is the
only thing that can prove the locker path, and it needs §2. Do not reorder.

---

## 0. Decisions that gate everything (Owner: operator)

Nothing below can be scheduled until these four are answered. They are
listed first because three of them cost money and one of them is
irreversible.

| # | Decision | Why it blocks |
|---|---|---|
| **L-01** | **Upgrade-authority policy** for `launchpad-curve` and `proposal-gate`: revoke (immutable, no bug fixes ever) or move to a multisig/governance (fixable, shared control). | REDTEAM §4c and §4b both name this as THE trust anchor. It changes what users are trusting and it is effectively one-way. |
| **L-02** | **RPC provider and plan** (mainnet, keyed). | Everything in §4 assumes a known rate limit; the indexer and the client both depend on it. |
| **L-03** | **Where the backend runs** (`railway.toml` exists; anything that can run a always-on process is fine). | §4 and the keeper. Must be able to run >1 instance later. |
| **L-04** | **Expected peak concurrent users**, order of magnitude. | 500 and 50,000 are different plans (PLAN-FRONTEND-SCALE §1). Sizes §4 and §6. |

Secondary but needed before money moves:

| # | Decision |
|---|---|
| **L-05** | **Protocol fee recipient** address — ideally a multisig, not a hot key. This receives all protocol revenue, and `config.authority` can change it. |
| **L-06** | **Keeper hot-wallet funding policy** — how much SOL it carries and who tops it up. It signs permissionless cranks; a drained keeper silently stops graduations. |
| **L-07** | **Curve profile for mainnet** — `PUMP_CLASSIC` (~85 SOL to graduate) is the production profile; `DEVNET_SCALED` exists only because faucets are small. Confirm production. |

---

## 1. Irreversible security — do this before anything touches mainnet

| # | Item | Owner | Blocking |
|---|---|---|---|
| **L-10** | Execute the L-01 policy on `launchpad-curve` (revoke or transfer). | operator | **YES** |
| **L-11** | Execute the L-01 policy on `proposal-gate`. | operator | **YES** |
| **L-12** | Decide and execute the policy for `config.authority` — it can move the fee recipient, the graduation tier, the lock program and the graduated split. An upgrade-locked program with a hot config authority is still a hot program. | operator | **YES** |
| **L-13** | Document in-product what a user is trusting: who can upgrade, who holds config authority, what they can and cannot change. | me | no |

**Verification (L-10/L-11):** `solana program show <id>` reports the intended
authority (or none), and the devnet audit's binary-match check still passes.
**Verification (L-12):** the config account's `authority` field reads the
intended address on chain.

**Note the sequencing trap.** Revoking upgrade authority before §2 and §5 are
finished means any bug found in the canary is unfixable. Two safe orders:
either (a) do §2, §5, then revoke; or (b) transfer to a multisig now and
revoke later. Do NOT revoke first.

---

## 2. Mainnet bring-up (Owner: me + operator keys)

The program has never been deployed to mainnet. Devnet is not the same
cluster and, for governance, not even the same programs (D-053).

| # | Item | Blocking |
|---|---|---|
| **L-20** | Deploy `launchpad-curve` to mainnet. Save the program keypair to `.wallets/` **before** deploying — the gate's was lost to a `target/` rebuild and its declared id became undeployable (D-053). | **YES** |
| **L-21** | Verify deployed bytes == `tests/fixtures/launchpad_curve.so.gz` (prefix compare; `solana program dump` returns the allocated length). | **YES** |
| **L-22** | `initialize_config` with mainnet addresses: CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`, create-pool fee receiver `DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8`, fee recipient from L-05, curve profile from L-07. | **YES** |
| **L-23** | `set_graduation_config` with the **1% tier** `G95xxie3XbkCqtE39GgQ9Ggc7xBC8Uceve7HFDEFApkc` (mainnet index 1 — the indices differ per cluster, which is why tiers are addresses) and the **locker** `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE`. This is what turns on the lock branch. | **YES** |
| **L-24** | Deploy `proposal-gate` to mainnet. `/launch` DEFAULTS to guarded; with no gate deployed every guarded launch fails, which is exactly the live break found on devnet (D-053). | **YES** |
| **L-25** | Point the app at mainnet: `NEXT_PUBLIC_CLUSTER`, program ids, RPC. | **YES** |
| **L-26** | Port `scripts/devnet-audit.ts` to a `--cluster mainnet` mode and run it. | **YES** |

**Verification:** the audit passes every check against mainnet, including
both binaries matching their fixtures and the config reading the intended
tier, locker and fee recipient.

---

## 3. Client hardening (Owner: me)

From PLAN-FRONTEND-SCALE §3 Stage 2 and §4. These are correctness-under-load,
not polish.

| # | Item | Blocking |
|---|---|---|
| **L-30** | **Dynamic priority fee.** `ConstantFeeEstimator` returns a fixed 10,000 µlamports: it overpays when quiet and fails to land exactly when a launch is hot. Sample `getRecentPrioritizationFees`, take a high percentile, apply a floor AND a ceiling, show it in the confirm UI, escalate on retry. `FeeEstimator` is already an interface. | **YES** — a trade that does not land is the product failing |
| **L-31** | Coalesce live updates into one state commit per animation frame. | **YES** at L-04 ≥ a few hundred |
| **L-32** | Reconnect with exponential backoff + jitter, resuming from a cursor so a reconnect backfills instead of silently skipping. | **YES** |
| **L-33** | Throttle hidden tabs (render and reconcile). | no |
| **L-34** | Virtualise the trade tape and any column past ~100 rows. | no |
| **L-35** | Optimistic local echo of your own trade, replaced by the confirmed event. | no |
| **L-36** | Skeletons and explicit error states on every chain-reading screen. | no |
| **L-37** | Code-split `/create` (324 kB first load; most visitors never launch). | no |

**Verification:** a synthetic feed at 50 events/s through the e2e harness with
assertions on render counts; unit tests replaying recorded congestion through
the fee estimator, asserting the ceiling holds.

---

## 4. Infrastructure (Owner: operator to provision, me to wire)

From PLAN-FRONTEND-SCALE §3 Stage 1. This is the item that decides whether a
crowd is affordable.

| # | Item | Blocking |
|---|---|---|
| **L-40** | Deploy `packages/backend` (indexer + API + SSE + keeper) on the L-02 RPC. | **YES** |
| **L-41** | Set `NEXT_PUBLIC_API_URL` so the app uses it. | **YES** |
| **L-42** | **When the API is configured, the client must stop scanning and stop subscribing to the RPC.** Today the chain-direct live path still runs; without this the per-user RPC cost stays. | **YES** |
| **L-43** | Keep chain-direct as an explicit degraded fallback, so an API outage is survivable. | **YES** |
| **L-44** | CDN the board endpoint with a short TTL + `stale-while-revalidate`. | no |
| **L-45** | Fund and monitor the keeper wallet (L-06). Graduations and fee collection are permissionless but happen only if somebody cranks. | **YES** |
| **L-46** | Domain, TLS, CORS pinned to the real origins (not open). | **YES** |

**Verification:** load test at 500 and 5,000 concurrent SSE clients against
staging with RPC call count recorded. **Pass condition: RPC calls do not rise
with client count.**

---

## 5. GATE L4 — the mainnet canary (Owner: operator go/no-go)

The lock path has **never run live**. Raydium's locker is absent from devnet
and hard-codes the mainnet CPMM id, so bankrun against the real binaries is
the primary proof and devnet only ever exercised the burn branch.

| # | Item |
|---|---|
| **L-50** | One real mainnet launch: create → buy to completion → migrate → **lock** → swap → `collect_graduated_fees`. |
| **L-51** | Verify on chain: the LP is with the locker, the fee-key NFT is held by the `["fee-authority", mint]` PDA, and the collected SOL/coin split lands where the model says. |
| **L-52** | Verify the migration reserve actually covered the lock (23,328,400 lamports on top of the pool overhead). |

**Cost:** a full production-profile graduation is ~85 SOL of raise (the raise
becomes pool liquidity; the LP is locked, so it is not recoverable) plus
overhead. Size this deliberately — it is the most expensive item in this
document.

**Verification:** GATES.md GATE L4 filled in with signatures, and the sign-off
line signed.

---

## 6. Observability and abuse (Owner: me to build, operator to receive alerts)

Without these, the failure mode is "users say it feels broken" and nothing to
look at.

| # | Item | Blocking |
|---|---|---|
| **L-60** | Server metrics: **indexer lag in slots** (the number that says the feed is behind), SSE client count, events/s, RPC calls/min and error rate. | **YES** |
| **L-61** | Alerts on indexer lag, SSE disconnect rate, RPC 429s, keeper balance below floor. | **YES** |
| **L-62** | Client telemetry: connection-state transitions, reconnects, event age, failed sends with reason. The status plumbing exists; nothing collects it. | no |
| **L-63** | Per-IP SSE connection caps (`maxClients` is global, not per client), body-size limits, method allowlist on the RPC proxy. | **YES** |
| **L-64** | A status page or banner the operator can flip during an incident. | no |

---

## 7. Launch day (Owner: operator, with me on hand)

**T-minus checklist — every line must be green:**

1. `pnpm build && pnpm test && pnpm lint` clean; e2e green.
2. Mainnet audit (L-26) passes every check.
3. Backend healthy; indexer lag near zero; SSE accepting connections.
4. Keeper funded above its floor.
5. GATE L4 signed (L-50–L-52).
6. §1 authority policy executed and verified on chain.
7. Fee recipient confirmed by reading the config on chain, not from memory.
8. Rollback rehearsed (below).

**Go/no-go.** Any red line is a no-go. There is no partial launch: the program
is the product, and a broken default path (guarded launches, L-24) fails
loudly for every user.

**Rollback.** Be honest that on-chain actions are not reversible:
- Frontend: revert the deploy — fast, safe, always available.
- Backend: scale to zero; the client falls back to chain-direct (L-43), which
  is why L-43 is blocking rather than nice-to-have.
- Program: **no rollback exists** if upgrade authority was revoked. If it was
  moved to a multisig, an upgrade is possible at multisig speed. This is the
  concrete reason L-01 matters.
- Pausing: there is no pause switch. Decide before launch whether that is
  acceptable; adding one is a program change and would need its own gate.

---

## 8. First 24 hours (Owner: operator)

- Watch indexer lag, keeper balance, RPC error rate, SSE client count.
- Watch the first real graduation end to end; it is the first time the lock
  path runs unattended.
- Re-run the mainnet audit after the first graduation.
- Keep a written incident log; it is the input to the next gate.

---

## 9. Devnet loose ends (Owner: me — not launch-blocking)

| # | Item |
|---|---|
| **L-90** | Finish GATE L5: `pnpm tsx scripts/devnet-guarded-advance.ts vfwHWftREkcTUGiqRdaMhCVEFB1tU6LpJvKHg4F6Wy3` — finalizable ~3 days after 2026-08-09, then execute after the 72h hold-up. |
| **L-91** | Indexer transaction fetch is serial inside the tick loop; fine at devnet volume, will fall behind a busy mainnet. Concurrency within a batch (SCALING.md). |
| **L-92** | SQLite → Postgres and split ingester/SSE nodes — only at ~5,000 concurrent (PLAN-FRONTEND-SCALE Stage 3). |

---

## 10. Residuals we are accepting with eyes open

These are NOT tasks. They are known, documented, and deliberately shipped.
Listing them here so nobody discovers them later and calls them surprises.

1. **Upgrade authority** is the trust anchor until L-10/L-11 resolve it.
2. **Devnet ≠ mainnet for governance**: devnet runs spl-governance 3.1.2,
   mainnet the 3.1.4 fork; Squads differs in binary and ProgramConfig (D-053).
   `tests/devnet-governance-parity` is what carries devnet evidence across.
3. **Sovereign hold-up 0** is an explicitly-labeled footgun (spec 12.2).
4. **Mode ratchet is governance-level** outside guarded mode.
5. **Inherited binaries**: spl-governance, Squads, VSR, Raydium CPMM and its
   locker. Program ids pinned, binaries fixture-hashed, deploy slots watched.
6. **`bigint-buffer` advisory**: no patch exists in the ecosystem; the native
   path is not loaded (pure-JS fallback) and inputs are fixed-width account
   slices.
7. **RPC trust for reads**: a malicious RPC can lie to the UI. Distribution
   roots are publicly recomputable; pin a trusted RPC.
8. **The client-side scan is linear** and is a fallback only (SCALING.md).

---

## Appendix — the DO-NOT-LAUNCH list

Short enough to hold in your head:

- Upgrade/config authority policy not executed (**L-10, L-11, L-12**)
- Mainnet binaries not verified against fixtures (**L-21, L-26**)
- Locker and 1% tier not set in config (**L-23**)
- proposal-gate not deployed — the DEFAULT launch path (**L-24**)
- Priority fee still a constant (**L-30**)
- Client still hitting the RPC per user with the API configured (**L-42**)
- No indexer-lag metric or alerting (**L-60, L-61**)
- Keeper unfunded or unmonitored (**L-45**)
- GATE L4 canary unsigned (**L-50**)
