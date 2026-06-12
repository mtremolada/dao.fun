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
regression tests on the real binaries. **But there is one HIGH-severity,
mainnet-blocking defect: the product's own launch API cannot actually create a
working DAO for the Token-2022 tokens it always launches.** Every successful
launch to date used standalone scripts that apply two Token-2022 adaptations
the backend orchestrator forgets. A real launch through the backend would
create the token (fees start flowing to its vault) and then fail to stand up
its governance — leaving an ungovernable token and a charged launch fee.

There is also a MEDIUM finding: the headline anti-capture guarantee ("a winning
attacker is locked through the drain") is **overstated for the shipping
configuration**, because production realms have no lockup (a consequence of
D-013 that the red-team write-up and property suite did not propagate). The
real protection is the cost of amassing quorum-weight of supply plus the
voting-window/hold-up notice (and the council veto) — still meaningful, but not
what the docs claim.

**Recommendation: NO-GO for mainnet launch until F-1 is fixed and F-2 is
re-documented.** Both are contained and have a clear, tested fix path. Nothing
found is a fund-theft hole in the deployed-binary custody design.

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

**Proposed fix (not applied — flag/prove/propose).** Make the Token-2022
adaptation part of the **sdk builder**, not each caller, so no launch path can
forget it:
1. In `buildCreateDaoIxs`, when the community mint is Token-2022 (detect via the
   mint account owner, which the orchestrator can fetch, or an explicit
   `communityTokenProgram` param), default `communityVoterWeightAddin` to `null`
   and emit the realm/governance instructions already targeting
   `TOKEN_2022_PROGRAM_ID` (and append the mint to deposit/withdraw per D-013).
2. Failing that, have `buildLaunchSteps` pass `communityVoterWeightAddin: null`
   and apply `retargetTokenProgram` to `groups.realmSetup`/`governanceSetup`,
   exactly as the mainnet scripts do — and add an **integration** test that
   drives `buildLaunchSteps` end-to-end on the real binaries (the current unit
   test cannot catch this class of bug).
Pin it with `tests/audit-orchestrator-token2022.integration.test.ts`, which
will flip from "reproduces the failure" to "guards the fix".

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

**Proposed fix.** (a) Correct REDTEAM §1 to state the real MVP protection
(quorum-acquisition cost + notice window + veto), and scope the lockup
dichotomy explicitly to a *future* VSR/voter-weight-plugin path (Stage 2/3).
(b) Add a property/regression test that models the **no-addin** path (weight ==
deposit, no lock) so the suite tests what ships. (c) Consider raising the
effective protection structurally — e.g. a custom voter-weight plugin that
restores lockup for Token-2022 — before claiming the lockup guarantee in
product. REDTEAM.md is updated by this audit (see its new §6).

---

### F-3 — LOW — launch fee is collected before the DAO is proven to stand up

**Where:** `packages/backend/src/launch-steps.ts` — step order is
`create-treasury → collect-launch-fee → create-token → create-dao → …`.

**What.** `collect-launch-fee` (launcher → protocol treasury) runs **before**
`create-dao`. Given F-1, a real launch charges the non-refundable launch fee and
creates the token, then fails to create governance — the launcher pays for an
ungovernable token. Independent of F-1, any `create-dao`/`create-token` failure
leaves the fee taken with no working DAO.

**Proposed fix.** Move `collect-launch-fee` to **after** `assert-invariants`
(charge only a proven-good launch), or make it refundable on abort. Low on its
own; it amplifies F-1's user impact.

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

**Proposed fix.** Use a 2- or 4-byte little-endian length for the account count
(mirror the data-length encoding). Pure hardening; changes the hash, so it would
need a coordinated artifact-format bump (note it for the Stage 3 hash freeze).

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

**Proposed fix.** Pass the actual vault-ATA `AccountInfo` (the orchestrator
already fetches chain state), or `null` with an explicit, documented external
ATA pre-create. Behaviour-preserving; removes a latent footgun. Pinned by the
existing buyback integration test.

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

**NO-GO** for a backend-orchestrated mainnet launch until:

1. **F-1 fixed** — the orchestrator must apply the Token-2022 adaptations
   (no-addin + token-program retarget), ideally inside `buildCreateDaoIxs`, with
   an **end-to-end** integration test driving `buildLaunchSteps` on the real
   binaries. This is the blocker: today the product cannot launch a working DAO.
2. **F-2 re-documented** — correct REDTEAM/property/GATES to describe the actual
   no-addin protection, and add a property test over the shipping config.

After those, the remaining findings (F-3 fee ordering, F-4 hash prefix, F-5
buyback placeholder) are non-blocking hardening. The custody, fee, execution-
fidelity, action-menu, and distributor designs are sound and now regression-
covered on the real binaries. F-6 is already fixed.
