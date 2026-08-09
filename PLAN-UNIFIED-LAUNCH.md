# PLAN — one launch page, Guarded unlocked, every option made simple

Operator directive (2026-08-09): *"just one launch page with all options on
it instead of selecting from the DAO types — unlock guarded mode and do a
full refactor for simple UI with all options made SIMPLE."*

Foundation: **D-042** — Option A ("gate the front door") is committed and
binary-verified (tests/guarded-gate-spike.integration.test.ts, 4/4 on the
deployed GovER5 v3.1.4 fork). This plan turns the verified design into the
product and collapses the launch funnel into a single simple page.

Doctrine unchanged: tests BEFORE code on everything here (funds + PDAs +
governance), every governance byte verified against the deployed binary,
evidence into DECISIONS/GATES/PROGRESS.

---

## What exists today (the refactor's inputs)

| Piece | State |
|---|---|
| Gate program (`programs/proposal-gate`) | `initialize`, `ratchet` (INV-11 one-way), `validate_transaction` (D-030 engine: parses real ProposalTransactionV2, unwraps Squads, whitelists outer+inner programs). NO create-proposal path. |
| Guarded ceremony | `buildCreateDaoIxs` THROWS on `mode: "guarded"`; `validateLaunchForm` rejects it; `types.ts` reserves the mode. |
| Launch UI | Mode chosen via `/launch?mode=…` (picker upstream on the home page); `LaunchForm` renders per-mode fields; three separate entries for what is really one decision. |
| Verified facts to build on | u64::MAX community create-weight = explicit disabled sentinel; delegate path closed; zero-weight council refused; the gate's sole council token authors proposals the COMMUNITY votes on (electorate = community mint). |

## R0 — Gate program v2: the front door (critical path)

New instruction `create_gated_proposal` on proposal-gate, tests first
against the REAL governance binary (extend the D-042 spike so the gate
**PDA** — not a Keypair stand-in — authors via CPI):

- **Accounts:** proposer (any signer; pays rent), gate config PDA, gate
  authority PDA (`["gate-authority", realm]` — owner of the council
  TokenOwnerRecord, signs via `invoke_signed`), realm, governance,
  community mint (the electorate), the gate's council TOR, proposal +
  proposal-deposit accounts, governance program, system program.
- **Logic:** (1) the D-030 validation engine clears the REQUESTED action
  set (same whitelist machinery `validate_transaction` uses — off-menu
  never comes to exist); (2) CPI `create_proposal` with the byte layout the
  spike already sends (0.3.28 client wire format, proven on the fork);
  (3) sign-off in the same transaction (owner sign-off, no signatories —
  spike-proven) so the proposal lands in Voting atomically.
- **Refusals to test:** uncleared action set; a proposer supplying a
  non-council TOR; a foreign realm's accounts; double-create on the same
  proposal seed.
- Toolchain per D-029 (cargo-build-sbf 4.0.0 / platform-tools v1.53
  curl-fetched); commit the gzipped fixture; delete the stale `.so` (the
  bankrun inflate gotcha).

## R1 — SDK: guarded ceremony + proposal routing

- `buildCreateDaoIxs("guarded")` (remove the throw): council mint created
  with EXACTLY ONE token minted to the gate authority PDA's ATA →
  deposit_governing_tokens creates the gate's council TOR → mint authority
  nulled; GovernanceConfig exactly as the spike pins it
  (`minCommunityTokensToCreateProposal = u64::MAX`, council = 1, council
  vote threshold Disabled, community electorate voting unchanged); gate
  `initialize` for the realm in the same ceremony.
- `buildProposeIxs` grows a guarded route: when the DAO is guarded, the
  create+sign-off legs go through `create_gated_proposal`; insert/execute
  legs unchanged (the D-030 ratchet already validates inserts).
- `validateLaunchForm`: guarded becomes selectable with NO extra inputs —
  the protection is structural, so the simplest mode to configure is the
  strongest one. That is the product point.

## R2 — ONE launch page, all options visible, all simple

Kill the mode-select funnel. `/launch` is the only entry:

- **Protection** — one radio-card row, four cards, plain words, no jargon:
  - **Guarded** *(default, "recommended")* — "Proposals can only come from
    the safety menu. The treasury cannot be drained even by a winning
    vote."
  - **Council** — "Trusted people you name can veto a bad proposal."
    Selecting reveals the members box + veto slider INLINE (same page).
  - **Cypherpunk** — "Pure token voting. No veto. Irreversible." Its
    one confirmation checkbox sits inside the card.
  - **Sovereign** — "No guardrails at all." Danger styling; both required
    confirmations inside the card; hold-up field inline.
- **Token** — name, symbol, image. Nothing else required.
- **Size (tier)** — the four tiers as a single segmented control with
  human copy ("micro — for testing and small communities"), defaulting to
  micro; the resolved numbers (quorum, hold-up) render live underneath in
  human units (72 h, not 259200 s).
- **Advanced** (one collapsed accordion): stricter-only overrides,
  pre-hosted metadata URI, dev buy.
- One Launch button; the existing step progress + runLaunch pipeline
  unchanged underneath. The shared contract (`validateLaunchForm`) stays
  the single validator — the page is presentation only.
- Delete `/launch?mode=…` handling and the home-page mode cards; redirect
  stale links to `/launch`.

## R3 — Proof and ship

1. Unit: launch-form contract tests (guarded accepted, zero-config); SDK
   ceremony builder tests (council-token-to-gate wiring, config bytes).
2. Integration: `createDao(ctx, "guarded")` end-to-end on real binaries —
   ceremony → gate authors a cleared proposal → community passes →
   execute through the custody chain; whale/delegate refused THROUGH THE
   PROGRAM PATH; off-menu action refused at creation.
3. e2e: single-page launch spec — all four protections selectable on one
   page, guarded default, confirmations enforced, launch pipeline drives
   to success against the stub.
4. Devnet: deploy gate v2, run one live guarded launch as the acceptance
   evidence; then docs (DECISIONS D-043+, PROGRESS, REDTEAM guarded row,
   RUNBOOK deploy step) and the Pages redeploy.

## Order & risk

R0 → R1 → R2 → R3, strictly: the page can't default to Guarded until the
program path exists. Riskiest first: R0's CPI byte layout (mitigated — the
spike already sends the exact bytes from the client side; R0 moves the same
bytes behind invoke_signed). The UI leg is deliberately last and thin: all
launch logic already lives in the shared contract, so the "simple" page is
a re-skin, not a rewrite.

Out of scope here: mainnet anything (GATE L3 remains the operator's
go/no-go), backend/indexer changes (none needed), token-2022, VSR changes.
