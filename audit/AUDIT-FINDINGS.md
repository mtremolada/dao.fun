# AUDIT-FINDINGS.md — adversarial security audit

**Date:** 2026-06-12 · **Auditor:** automated agent (Fable 5), branch
`claude/audit-execution-oaj5aa` · **System under test:** Stage 1 MVP +
Stage 3 WIP at the head of `claude/audit-execution-oaj5aa`, against the
deployed mainnet binaries in bankrun (hermetic; no mainnet, no keys, no
deploys).

> See `audit/AUDIT-SPEC.md` for the (reconstructed) phase plan and the
> provenance note explaining why the referenced spec/D-033..D-034 did not
> exist and were reconstructed.

## Bottom line (plain English)

The MVP is technically strong: custody, fee collection, execution fidelity, the
action-menu bounds, and the merkle distributor are all sound and now have
regression tests on the real binaries. The audit found one HIGH-severity,
mainnet-blocking defect — **the product's own launch API could not create a
working DAO for the Token-2022 tokens it always launches** — plus a MEDIUM
threat-model overstatement and three low/informational items.

**Status: all findings are now FIXED and proven on the real binaries**
(F-1..F-6), with the fixes pinned by tests. The HIGH defect (F-1) is corrected
inside the sdk builder so no launch path can forget the Token-2022 adaptations,
and both cypherpunk and council Token-2022 DAOs now stand up end-to-end on the
deployed binaries. The MEDIUM (F-2) is re-documented (REDTEAM §6) with the real
protection model and demonstrated on the real binary.

**Updated recommendation: GO for mainnet is unblocked from the audit's side**,
contingent on the operator's standing GATE sign-offs and the standard
mainnet-transition checklist (SPEC §10/§11). Nothing found is a fund-theft hole
in the deployed-binary custody design.

> The sections below describe each finding **and the fix applied**. "What"
> documents the defect; "Fix" documents the change now in the tree.

## Phase 0 — green baseline (reproduced)

| Suite | Result |
|---|---|
| sdk unit | 137 passed |
| keeper unit | 19 passed |
| backend unit | 62 passed |
| app unit | 16 passed |
| **unit total** | **234 passed** |
| integration (real binaries, bankrun) | 21 passed / 11 files |
| build (`pnpm -r build`) | clean |
| eslint | clean |
| tsc (`tsconfig.json`, tests+scripts) | **3 pre-existing errors** in `tests/action-amm.integration.test.ts` (see F-6) |

Baseline matches the documented "234 unit + 21 integration". The tsc errors
were latent (type-only; vitest strips types via esbuild so tests still ran) and
are fixed as part of this audit (F-6).

After the audit: **243 unit** (+4 backend INV-9 recompute, +5 sdk setParam
preservation) and **26 integration / 14 files** (+3 F-1 cases, +1 F-2, +1 INV-9
direct-leg). All green; eslint + tsc clean.

---

## Findings

### F-1 — HIGH — the launch orchestrator cannot stand up a DAO for a Token-2022 mint

**Where:** `packages/backend/src/launch-steps.ts` (`buildLaunchSteps`, the
`create-dao` step) → `packages/sdk/src/governance.ts` (`buildCreateDaoIxs`).

**What.** Every pump `create_v2` mint is Token-2022 (D-004). The deployed VSR
rejects Token-2022 community mints (D-013/D-018), and the deployed
spl-governance needs the community-mint **token program retargeted to
Token-2022** on the realm/holding-account instructions (the 0.3.28
`withCreateRealm` hardcodes the classic Token program). D-013 records the
consequence: *"Production launch path must use the no-addin realm."*

The only launch code ever executed against the real binaries —
`scripts/mainnet-gate1-sovereign*.ts` — applies **both** adaptations:
`communityVoterWeightAddin: null` **and** `retargetTokenProgram(...)`. The
bankrun harness (`tests/helpers/bankrun-harness.ts`) also passes
`communityVoterWeightAddin: null`.

The **product orchestrator does neither.** `buildLaunchSteps` calls
`buildCreateDaoIxs({ mint, payer, mode, params, council? })` with no
`communityVoterWeightAddin` (so it defaults to the VSR addin —
`governance.ts:140`) and no retarget. Its `create-dao` step is only unit-tested
**offline** (`launch-steps.test.ts` with a fake `sendAndConfirm`), so the
defect is never executed against a real binary. The grep is unambiguous: the
`null` addin and `retargetTokenProgram` appear in the scripts, the harness, and
the unit test — but never in `packages/backend/src`.

**Blast radius.** The launch sequence creates the token (`create-token`,
creator = vault, INV-1) *before* `create-dao`. So a real backend launch:
1. creates a live Token-2022 token on the curve whose creator fees accrue to
   the Squads vault, then
2. **fails at `create-dao`** (the `realmSetup` transaction reverts at its very
   first instruction), leaving a token whose governance chain can never be
   stood up through the product. Resume re-runs `create-dao` and fails again.

Fees then accrue to a vault whose sole controller (the governance native
treasury) never comes into existence — the GATE-0a "recoverable only by
standing up governance, treated as sunk" situation, except the orchestrator
*cannot* stand up governance at all. The launch fee (F-3) was already taken.

**Proof (real binaries):**
`tests/audit-orchestrator-token2022.integration.test.ts` —
- the orchestrator's exact `buildCreateDaoIxs` output for a Token-2022 mint has
  a `realmSetup` containing VSR instructions, and **fails on-chain**
  (`InitializeAccount: IncorrectProgramId` — the classic Token program on the
  Token-2022 holding account; VSR would fail next);
- even with the addin dropped, the **un-retargeted** `createRealm` still fails
  (isolating the second missing adaptation);
- `communityVoterWeightAddin: null` **+** `retargetTokenProgram` stands the
  realm up cleanly (the script-proven path).

**Fix (applied).** The Token-2022 adaptation now lives in the **sdk builder**,
so no launch path can forget it:
- `buildCreateDaoIxs` gained a `communityTokenProgram` param. When it is
  `TOKEN_2022_PROGRAM_ID` the builder (a) defaults `communityVoterWeightAddin`
  to `null`, (b) retargets the classic-Token-program account in the
  realm/governance instructions to Token-2022, and (c) mints the council
  membership token under Token-2022 too — because `withCreateRealm` passes ONE
  token-program account for both the community and council holding accounts, so
  they must share a program. The classic-mint path is unchanged (default param).
- `buildLaunchSteps` now passes `communityTokenProgram: TOKEN_2022_PROGRAM_ID`
  (pump mints are always Token-2022, D-004).

**Proof (real binaries):** `tests/audit-orchestrator-token2022.integration.test.ts`
now proves the FIX — the orchestrator's Token-2022 builder output executes the
full `realmSetup`+`governanceSetup` for **cypherpunk** *and* **council** (a
Token-2022 council mint + realm + governance, a combination never previously
validated) on the deployed binaries — and pins that the legacy default (classic
program) still fails, so the adaptation cannot be silently dropped.

*Follow-up (not blocking):* the browser deposit/withdraw tx-builders (D-028)
should get the same Token-2022 mint-append the mainnet scripts apply; that path
is voting, not launch, and out of this finding's scope.

---

### F-2 — MEDIUM — the anti-capture guarantee is overstated for the shipping (no-addin) configuration

**Where:** `REDTEAM.md` §1.1/§1.2, `packages/sdk/test/property-capture.test.ts`,
GATES.md GATE 2(b/d); root cause D-013.

**What.** The documented capture-resistance rests on VSR lockup weighting:
*"Unlocked deposits carry ZERO vote weight (VSR baseline-0)"* and the
hit-and-run dichotomy *"EITHER the attacker's capital is still locked when the
drain executes OR the drain took ≥ saturation×quorum% of public notice."* The
property suite tests the VSR weight formula.

But the shipping path is **no-addin** (D-013, and F-1's correct fix keeps it
no-addin): vote weight is the **plain deposited token amount with no lockup**.
The VSR zero-weight gate and the "locked-through-drain" arm therefore **do not
apply to the configuration the product actually ships**. An attacker who can
reach quorum can deposit unlocked tokens, vote, **withdraw the entire stake
before execution**, and let the drain land — never at capital risk through the
hold-up.

**Proof (real binary):** `tests/audit-f2-no-lock.integration.test.ts` — in the
production no-addin realm a voter deposits the full supply, passes a
vault-draining proposal to `Succeeded`, then **relinquishes and withdraws the
entire stake back to their wallet while the proposal is still in its hold-up
window and the vault is still funded**, and the drain still executes after the
hold-up. Capital recovered in full, before the drain — the "locked through
drain" claim is false here.

**Severity rationale.** This is a **documentation/threat-model integrity**
finding, not a cheap new exploit: reaching quorum still requires amassing
`quorumPercent` of the max vote weight (25% of supply at micro tier under
`FULL_SUPPLY_FRACTION`), which is economically large and price-moving, and the
voting-window + hold-up notice and the council veto still hold. The **product
UI copy for cypherpunk is already honest** ("your only protection is
information and the exit window"). The gap is that REDTEAM/property/GATES
advertise a *stronger, capital-at-risk* guarantee that the MVP does not deliver.

**Fix (applied).** REDTEAM.md §6 now states the real MVP protection
(quorum-acquisition cost + notice window + veto) and scopes the lockup
dichotomy explicitly to a *future* VSR/voter-weight-plugin path. The no-lock
behaviour is pinned on the real binary by
`tests/audit-f2-no-lock.integration.test.ts`. *Recommended (not blocking):* add
a property test over the no-addin weight model, and consider a custom
Token-2022 voter-weight plugin before advertising a lockup guarantee in product.

---

### F-3 — LOW — launch fee is collected before the DAO is proven to stand up

**Where:** `packages/backend/src/launch-steps.ts` — step order is
`create-treasury → collect-launch-fee → create-token → create-dao → …`.

**What.** `collect-launch-fee` (launcher → protocol treasury) runs **before**
`create-dao`. Given F-1, a real launch charges the non-refundable launch fee and
creates the token, then fails to create governance — the launcher pays for an
ungovernable token. Independent of F-1, any `create-dao`/`create-token` failure
leaves the fee taken with no working DAO.

**Fix (applied).** `collect-launch-fee` now runs **after** `create-dao` and
`prefund-treasury` (just before the read-only `assert-invariants`), so a failed
`create-dao` never debits the launcher. Pinned by the updated
`packages/backend/test/launch-steps.test.ts` (step order + resume semantics).

---

### F-4 — LOW/INFO — `computeInstructionSetHash` uses a 1-byte account-count prefix

**Where:** `packages/sdk/src/artifact-hash.ts` — `h.update(Buffer.from([ix.keys.length]))`.

**What.** The canonical instruction-set hash (INV-9's anchor) length-prefixes
each instruction's account list with a **single byte**. For an instruction with
≥256 account metas this wraps (256 → 0), making two distinct instruction sets
hashable to the same digest. **Not exploitable today** — a ProposalTransaction
instruction with 256+ metas cannot fit the governance `InsertTransaction` within
the 1232-byte tx limit, and Solana legacy messages cap account indexes at u8 —
so the input is structurally bounded well under 256. The data-length field
already uses a correct 4-byte prefix; the account count should match.

**Fix (applied).** `computeInstructionSetHash` now uses a 4-byte LE length for
the account count, matching the data-length field — canonical and
non-wrapping. No test pinned a literal hash (all comparisons are publish-vs-
recompute with the same function), so the format change is internally
consistent and all INV-9 tests still pass. Note for the record: this changes
artifact-hash values, so any externally cached pre-audit hashes would differ
(none are in scope here).

---

### F-5 — LOW/INFO — `buildBuybackIxs` passes a wrong-typed account as `associatedUserAccountInfo`

**Where:** `packages/sdk/src/actions.ts` `buildBuybackIxs` —
`associatedUserAccountInfo: p.bondingCurveAccountInfo`.

**What.** To suppress the sdk's ATA-create instruction (the vault ATA is
pre-created), the builder passes a **non-null placeholder of the wrong account
type** (the bonding-curve account) where the user's token-account info is
expected. It works today — `tests/action-buyback.integration.test.ts` proves the
buy lands tokens in the vault on the real binary, i.e. pump-sdk only checks
null-ness here — but it is fragile to any pump-sdk change that *decodes* that
field.

**Fix (applied).** `BuybackParams` now has an explicit `userTokenAccountInfo`
(the vault's pre-created token ATA), passed as `associatedUserAccountInfo`. The
wrong-typed `bondingCurveAccountInfo` placeholder is gone. Behaviour-preserving
(the ATA is still treated as existing, no in-proposal create); the action-buyback
integration test passes the real vault-ATA info and still lands tokens in the
vault on the real binary.

---

### F-6 — INFO (FIXED in this audit) — pre-existing tsc errors in `action-amm.integration.test.ts`

The repo's "tsc clean" claim did not hold for `tests/` under `tsconfig.json`:
`toRawMint`/`toRawAccount` returned object literals whose `…Option`/`state`
fields widened to `number`, incompatible with `RawMint`/`RawAccount`'s `0 | 1`
unions (`exactOptionalPropertyTypes`/literal unions). Type-only (esbuild strips
types, so tests ran), but it is a real type-safety gap. **Fixed** by annotating
both helpers with their `RawMint`/`RawAccount` return types so the literals are
contextually checked. tsc is now clean (exit 0); the test still passes on the
real binaries.

---

## Safe verdicts, now backed by regression tests

These are load-bearing invariants the audit attacked and could not break; each
now has a test so the verdict cannot rot silently.

- **INV-9 chain recompute == publish-time hash, for every wrapped shape.**
  `packages/backend/test/audit-inv9-recompute.test.ts` (plain vault chain,
  buffered chain, direct-leg-only via the `catch` raw-hash fallback, and
  vault+direct staged). The integration suite only covered plain vault chains;
  this closes the buffered / direct / staged gaps. Plus
  `tests/audit-inv9-directleg.integration.test.ts` proves it **end-to-end on the
  real binary** for a direct-leg-only (setParam) proposal re-read from chain.
- **setParam ratchet-by-omission preserves every non-target config field.**
  `packages/sdk/test/audit-setparam-preservation.test.ts` — starting from a
  council config with an **active 55% veto**, each of the four whitelisted
  params is changed and *all* other fields (incl. `councilVetoVoteThreshold`
  value, `communityVetoVoteThreshold`, `councilVoteThreshold`,
  `councilVoteTipping`, `votingCoolOffTime`, `depositExemptProposalCount`) are
  asserted byte-identical. The integration test only spot-checked a subset; the
  veto an attacker would want to drop is now explicitly pinned.
- **Custody / keeper / distributor** (INV-2, INV-7, INV-8, distribute soundness)
  were re-reviewed and remain backed by the existing real-binary suites
  (treasury non-member rejection, `sweepVault` INV-2 refusal, gross-only
  accounting, merkle double-claim/tamper rejection). No new gaps found.

---

## INV-1..11 traceability

| INV | Statement | Status | Evidence |
|---|---|---|---|
| INV-1 | pump `creator` == DAO Squads vault, never a user wallet | **Holds** | `pump-rail.test.ts` (creator arg, not signer); `launch-steps.ts` create-token uses vaultPda; gate0a/gate0b/0c on real binaries |
| INV-2 | Fee collection needs no creator signature; keeper signs only as fee-payer | **Holds** | D-006; `keeper.ts` signer refusal; `keeper.test.ts`; GATE-0a live |
| INV-3 | No proposal executes before its hold-up (except explicit sovereign-0) | **Holds** | gate1-matrix (72h refusal then execute); action-setparam (new floor binds) |
| INV-4 | Fund-moving proposal needs weighted YES ≥ threshold, + council veto absence | **Holds, but weight is unlocked deposit in production** | gate1-matrix council/VSR legs; **F-2** — production weight has no lockup |
| INV-5 | Mint authority null after launch | **Holds** | `launch-steps.ts` assert; gate1 sovereign-p2 (mint+freeze null) |
| INV-6 | Checked balance math; no silent overflow | **Holds** | bigint end-to-end; `fuzz-bounds.test.ts`; snapshot JSON>2^53 refusal (D-026) |
| INV-7 | No human-held unilateral key in custody; sole member = native treasury | **Holds** | `treasury.ts` (configAuthority null, single member); `launch-steps.ts` assert; gate1 on real binary |
| INV-8 | Vault inflow per sweep == gross accrued; no skim at this layer | **Holds** | `keeper.ts` gross delta; action-amm/keeper integration (gross >= curve+amm) |
| INV-9 | Executed instructions byte-identical to what voters saw; hash-keyed | **Holds** | gate1 chainHashOf; **now also** audit-inv9-recompute (all 4 shapes) + audit-inv9-directleg; **F-4** latent hardening |
| INV-10 | Every proposal surfaces sim + decoded summary; undecodable flagged | **Holds** | `detectProposalAnomalies`; chain-reader unwrap; backend anomalies tests |
| INV-11 | Mode ratchets only toward decentralization (MVP governance-level; Stage 3 structural) | **Holds at documented level** | setParam ratchet-by-omission (now full-field regression); proposal-gate `ratchet` (Stage 3 WIP, reviewed); spec 12.2 caveat |

---

## Out-of-MVP review (Phase 6 — proposal-gate, Stage 3 WIP)

Not in the mainnet scope (Guarded mode is unshipped and its enforcement seam is
mid-redesign per D-032), but reviewed: the on-chain `Reader` is fully
bounds-checked; `validate_transaction`'s ProposalTransactionV2 / Squads message
parse matches the layouts (account-type tag 13, the 3-byte message header,
34-byte metas, u32 vec prefixes); `ratchet` enforces strict one-way movement
gated on the governance signer; the whitelist is immutable post-init. The honest
v1 limits (program-level not per-instruction byte validation; clearances not yet
consumed) are documented in D-030. **No action for MVP**; re-audit when the
enforcement seam lands and before any custom-program mainnet deploy (GATE 3
already requires an external audit).

## Mainnet go/no-go

**GO (audit-side), with the standard pre-mainnet checklist.** The HIGH blocker
(F-1) is fixed inside the sdk builder and proven on the deployed binaries for
both shipping modes; F-2 is re-documented and demonstrated; F-3/F-4/F-5/F-6 are
fixed. The custody, fee, execution-fidelity, action-menu, and distributor
designs are sound and regression-covered on the real binaries.

Remaining items the operator owns before a real launch (outside audit scope):
- the standard mainnet transition (SPEC §10/§11): operator-supplied
  upgrade-authority/treasury, funding, mainnet smoke test;
- **recommended** before advertising any lockup guarantee: a no-addin property
  test (F-2) and/or a Token-2022 voter-weight plugin;
- **recommended**: extend the Token-2022 mint-append to the browser
  deposit/withdraw tx-builders (F-1 follow-up).

Verification at audit close: **243 unit + 26 integration green** (real binaries,
hermetic); **eslint clean; tsc clean**.
