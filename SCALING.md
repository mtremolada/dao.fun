# Scaling — what breaks, in what order, and what it costs

Written from measurements, not intuition (2026-08-09). Numbers are from the
live devnet deployment and the code as it stands.

## The shape of the problem

Two very different costs get confused with each other:

- **Cost per VISITOR.** Someone opening the board. Grows with traffic.
- **Cost per TRANSACTION.** Someone launching or trading. Grows with usage.

The serverless deploy pays the first cost against the RPC on every page load.
The indexer converts it into a single server-side cost paid once per
transaction, which is the only version of this that scales.

## Where we are

The board reads the chain directly, and after today's fix that read is
**bounded**: one `getProgramAccounts` for the curves, then metadata for only
the coins that will actually be drawn (50 per column). Measured: **2 RPC
calls, whatever the launchpad's size** — asserted in `app/test/board-scale`
at 10 coins and at 50,000.

Capping the columns introduced a trap worth naming, because it is the sort of
thing that reads as correct: this browser's remembered mints are deduped
against EVERY scanned coin, not against the fifty shown. Deduping against the
displayed set would mean a heavy user's sixty remembered coins each cost a
read — unbounded cost aimed precisely at the people who use the site most.
Remembered mints the scan genuinely did not return (a coin created seconds
ago) are read individually and capped at twelve.

What is NOT bounded is the scan's payload, and it cannot be:

| coins | scan payload per page load |
|---|---|
| 11 (today) | 4.8 KB |
| 100 | 44 KB |
| 1,000 | 0.44 MB |
| 10,000 | 4.4 MB |
| 100,000 | 44 MB |

440 bytes per coin, measured against devnet. A client-side full scan is
inherently linear, so this is comfortable to ~1,000 coins, unpleasant at
10,000, and impossible past that.

**The other reason this is a devnet-only convenience:** public RPC providers
commonly restrict or disable `getProgramAccounts` on mainnet, and a scan on
every page load is exactly the access pattern they restrict it for. Plan on a
keyed RPC regardless (already true for holder snapshots — D-026).

## The fix already exists

`packages/backend` is a working indexer + API + SSE feed, tested, with a
`railway.toml`. It is simply not deployed.

- **Ingest is incremental and correct**: a signature cursor over the program
  (`getSignaturesForAddress` → `getParsedTransaction` → apply events → SQLite).
  It advances the cursor only over fully applied history, and stops at a gap
  rather than skipping it, so a failed read is retried instead of losing
  trades.
- **Serving is bounded**: `/launchpad/board?filter=&limit=` is capped at 200,
  SQL-indexed, rate-limited per IP; live updates go over one SSE connection
  instead of polling.
- **The app already prefers it.** `apiConfigured()` switches the board to the
  API when `NEXT_PUBLIC_API_URL` is set, and the Pages workflow already passes
  that variable through. Turning it on is a repo-variable change, not a code
  change — and the chain-direct path stays as the fallback, which is a real
  resilience property worth keeping.

Per-visitor cost after that: one bounded HTTP response, served from memory,
independent of both the launchpad's size and the chain.

## What will break next, in order

1. **RPC provider limits, before anything else.** Both the scan (per visitor)
   and the indexer (per transaction) go through one RPC. This is the first
   thing to hit, and the cheapest to fix: a keyed provider.

2. **Indexer throughput, at high volume.** `runTick` fetches transactions
   ONE AT A TIME, serially, up to `pageLimit` (100) per tick with a 4s default
   poll. That is fine at devnet volume and will fall behind a busy mainnet
   launchpad. The fix when it matters, cheapest first:
   - raise `pageLimit` and drop `INDEXER_POLL_MS` (config only);
   - fetch the batch's transactions concurrently instead of in a loop (the
     cursor semantics still hold — it applies in slot order and only advances
     over what applied);
   - move to a push feed (webhook/Geyser) so there is no polling at all.

3. **SQLite writes**, single instance. Fine into the millions of rows; the
   answer beyond that is Postgres behind the same store interface, which is
   why the store is an interface.

4. **The board's own semantics.** At thousands of coins "top 50 by raise" is
   the wrong ranking — it needs recency and volume windows, which is an
   indexer feature (it has `created_slot` already), not a client one.

## The honest summary

Nothing here needs rearchitecting. The scaling path is: **point
`NEXT_PUBLIC_API_URL` at a deployed backend, on a keyed RPC.** Everything
above that is tuning, and every step is behind a config value rather than a
rewrite. The client-side scan is a genuinely useful fallback for a launchpad
this size and an actively bad idea at a hundred times this size — which is
why it is bounded, measured, and documented rather than quietly relied upon.
