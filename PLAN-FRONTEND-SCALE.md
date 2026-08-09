# PLAN — a front end that holds up with a crowd on it

Operator directive (2026-08-09): *"I need a real front end with a client that
works at scale with a bunch of users when its live."*

Written from measurements of the current build, not from intuition. The
numbers below are derived from what this deployment actually does today.

---

## 1. The thing that breaks, and it is not what it looks like

Today every browser is its own indexer. On page load it scans the program; it
opens its own WebSocket; it holds its own `programSubscribe`; and it re-scans
every 30 seconds to guard against a dead socket. That is correct, honest
engineering for one user and it is the wrong shape for a crowd, because
**every cost is multiplied by the number of people watching.**

At 100 coins (measured: 440 bytes per coin in a scan response):

| concurrent users | reconcile scans | RPC WebSockets | page-load scans |
|---|---|---|---|
| 50 | 0.1 MB/s | 50 | 50 |
| 500 | 0.7 MB/s | 500 | 500 |
| 5,000 | 7.3 MB/s | 5,000 | 5,000 |
| 50,000 | 73.3 MB/s | 50,000 | 50,000 |

The site does not fall over at those numbers — **the RPC bill does**, and then
the provider rate-limits us and the site falls over anyway. Note also that
`programSubscribe` streams every account the program touches to every
connected client, so the fan-out is paid per viewer by the RPC rather than by
us. Providers restrict it for exactly this reason.

**The inversion.** One server subscribes once, keeps the state, and fans out
small deltas. RPC cost becomes constant in the number of users:

| concurrent users | RPC cost | our egress at 5 trades/s (~200 B deltas) |
|---|---|---|
| 50 | constant | 0.1 MB/s |
| 5,000 | constant | 5 MB/s |
| 50,000 | constant | 50 MB/s |

Egress we can shard, cache and pay for predictably. RPC calls multiplied by
users, we cannot.

**This is already built.** `packages/backend` is a working indexer + HTTP API
+ SSE fan-out with a `railway.toml`, and the app already prefers it whenever
`NEXT_PUBLIC_API_URL` is set. The plan is mostly *turning the existing
architecture on* and then hardening it, not designing a new one.

## 2. Where the front end itself stands

Good: it is a static export on a CDN, so assets are effectively free and the
origin cannot be a bottleneck. Wallet signing is client-side and each user
broadcasts through their own wallet's RPC, so **the trading path does not
centralise** — that stays true at any scale and is worth protecting.

Weak spots, measured from the build:

```
/            209 kB first load
/coin        221 kB
/create      324 kB   <- the governance + Squads SDKs
shared       103 kB
```

- `/create` at 324 kB is the heaviest route and most visitors never launch.
- The board re-renders on every push. At one trade a second that is fine; at
  fifty it is a React render storm, and nothing coalesces or virtualises.
- No skeletons, so a slow RPC shows an empty page rather than a loading one.
- Nothing throttles work in a hidden tab beyond the trade poller.

## 3. Staged plan

Each stage is useful on its own, has a trigger, and has a way to prove it.

### Stage 1 — Turn on the server (the whole ballgame, ≈1 day)
**Trigger: before any public launch.**

1. Deploy `packages/backend` (Railway config exists) on a **keyed RPC**. Set
   `NEXT_PUBLIC_API_URL`; the app switches itself over.
2. Put the board endpoint behind a CDN with a short TTL and
   `stale-while-revalidate`, so a burst of arrivals is one origin read.
3. Client: when the API is configured, **stop scanning and stop subscribing to
   the RPC entirely** — today the live path is chain-direct and would still
   run. This is the change that actually removes the per-user RPC cost.
4. Keep the chain-direct path as the fallback it already is, behind a clear
   "degraded" state, so an API outage is survivable rather than fatal.

*Prove it:* a load test (k6 or similar) at 500 and 5,000 concurrent SSE
clients against a staging instance, with RPC call count recorded. The pass
condition is that RPC calls do not rise with client count.

### Stage 2 — Make the client behave under fire (≈1–2 days)
**Trigger: same release. These are correctness-under-load, not polish.**

- **Coalesce renders.** Batch incoming deltas into one state commit per
  animation frame. One trade or fifty in a frame should cost the same render.
- **Virtualise long lists.** The trade tape and any column past ~100 rows.
- **Backpressure and reconnect.** Exponential backoff with jitter on the SSE
  connection, resume from a cursor so a reconnect backfills instead of
  silently skipping, and a visible connection state (the honest-status work in
  `app/lib/live.ts` already establishes the pattern).
- **Pause hidden tabs.** Stop rendering and drop to a slow reconcile when
  `document.hidden`; a hundred background tabs should not cost what a hundred
  foreground ones do.
- **Optimistic local echo** of your own trade, replaced by the confirmed
  event. This is what makes it feel instant rather than fast.
- **Skeletons and error states** on every screen that reads the chain.

*Prove it:* a synthetic feed at 50 events/s driven into the e2e harness, with
assertions on render counts, plus Playwright traces for frame timing.

### Stage 3 — Horizontal (≈2–3 days)
**Trigger: ~5,000 concurrent, or the first time one box saturates.**

- Move the store from SQLite to Postgres behind the existing store interface
  (it is an interface precisely so this is a swap, not a rewrite).
- Split the single process into **ingester** (one, owns the cursor) and **N
  stateless API/SSE nodes**, with Redis pub/sub as the event bus between them.
  SSE fan-out is then horizontal.
- Ingest concurrency: the indexer currently fetches transactions one at a time
  inside its tick loop. Fetch a batch concurrently — the cursor semantics
  already tolerate it, since it applies in slot order and advances only over
  what applied.

*Prove it:* the same load test at 20,000 concurrent across two nodes, and a
replay test that a killed ingester resumes without gaps or duplicates.

### Stage 4 — When the chain feed is the limit
**Trigger: sustained volume where polling signatures cannot keep up.**

Replace signature polling with a push feed (Geyser or a provider webhook).
This is the only stage that changes how data *enters* the system, and it is
not worth doing before the ingester is the measured bottleneck.

## 4. The trade itself has to land, not just render

"Works at scale" includes the moment a crowd all tries to buy the same coin.
Most of this path is already right, and one part is not.

Already right, and worth not breaking: the sender adds a compute-unit price,
manages the blockhash and its expiry, runs preflight, and on rebroadcast sends
**the same signed bytes** rather than re-signing under a fresh blockhash —
which is what stops a retry from becoming a second, duplicate trade.

The gap: `ConstantFeeEstimator` returns a fixed 10,000 µlamports. That is a
guess that is wrong in both directions — it overpays on a quiet chain and, far
worse, fails to land exactly when a launch is hot and everyone is bidding for
the same block. `FeeEstimator` is already an interface, so the work is an
implementation, not a redesign:

- sample `getRecentPrioritizationFees` for the accounts the transaction
  actually writes, take a high percentile, and apply a floor and a **ceiling**
  so a fee spike cannot quietly drain a user;
- show the fee in the confirm UI, because a trading interface that spends the
  user's money on urgency without telling them is not one they will trust;
- escalate on retry rather than resending at the same price.

*Prove it:* replay recorded congestion (fees from a busy period) through the
estimator in unit tests, and assert the ceiling holds. Landing rate itself can
only be measured for real on mainnet.

## 5. Knowing what is happening

None of the above is operable without numbers, and at that point the failure
mode is "users say it feels broken" with nothing to look at.

- **Client**: report connection state transitions, reconnect counts, event
  age (now minus slot time), and failed sends with their reason. The status
  plumbing in `app/lib/live.ts` already produces the signal; nothing collects
  it.
- **Server**: SSE client count, events published per second, indexer lag in
  slots, RPC calls per minute and their error rate. Indexer lag is the single
  most important number — it is the one that says the feed is behind.
- **Alert on**: indexer lag over a threshold, SSE disconnect rate, RPC 429s.

## 6. Abuse, since it is a public endpoint

The backend already token-buckets the RPC proxy and cools down the airdrop per
IP and per pubkey. Before a public launch: per-IP SSE connection caps (the
`maxClients` default of 1,000 is global, not per client), a body-size limit on
anything that writes, and CORS pinned to the real origins rather than open.

## 7. Decisions I need from you

These are yours because they cost money and cannot be inferred:

1. **RPC provider and plan.** Needed for Stage 1 and for mainnet regardless.
   Everything downstream assumes a keyed endpoint with a known rate limit.
2. **Where the backend runs.** `railway.toml` exists; Fly/Render/a VPS are all
   fine. Stage 3 assumes it can run more than one instance.
3. **Expected peak.** "A bunch of users" sizes the plan very differently at
   500 than at 50,000. Stage 1 covers the former comfortably.
4. **Budget shape.** Egress and RPC are the two real line items; both scale
   with viewers rather than with coins.

## 8. What I would do first

Stage 1 plus the coalescing and reconnect items from Stage 2. That is the
combination that takes the current build from "correct for one user" to
"correct for a crowd", and everything after it is a threshold response rather
than a redesign.

The honest framing: the architecture is already right, and the work is mostly
turning on the half that is built and not deployed, then making the client
behave when the feed gets loud.
