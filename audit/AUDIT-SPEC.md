# AUDIT-SPEC.md — full end-to-end security audit of the PumpFun DAO Launchpad

> **This is an execution spec for a FRESH session.** It is written to be
> handed to an autonomous auditor who has the repo but not this
> conversation's context. Read this whole file first, then `SPEC.md`,
> `DECISIONS.md` (D-001..D-034), `REDTEAM.md`, `GATES.md`, `VERSIONS.md`,
> and `CLAUDE.md`. Everything you need to reproduce is in the repo.

---

## 0. Mission & doctrine

**Mission:** find every way this system can lose user funds, execute an
instruction users did not approve, be captured by a minority, or
mislead a user about what will happen — across the on-chain program, the
governance integration, the economics, the off-chain stack, the build,
and the deployment. Produce a findings register a third-party auditor
(Sec3/OtterSec/Neodyme) would accept, and a defensible **go / no-go for
mainnet** recommendation.

**You are the adversary.** Assume a motivated attacker with capital, the
ability to submit any transaction, run a keeper, create proposals, sit
on the council, and front-run the launch ceremony. Assume the deployed
SPL-governance program is a **fork** (`GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`,
self-reports v3.1.4) whose source you do **not** have — only the dumped
binary in `tests/fixtures/spl_governance.so.gz`. Trust nothing you have
not re-derived from the binary or proven with a test.

**Doctrine (non-negotiable):**
1. **Tests-first, on real binaries.** Every claimed vulnerability gets a
   *failing-by-default* reproduction test in `bankrun` against the real
   mainnet binaries (the harness is `tests/helpers/bankrun-harness.ts`).
   Every claimed mitigation gets a test that fails if the mitigation is
   removed. No finding is "confirmed" without a runnable repro, and no
   "safe" verdict without a test that would catch the break.
2. **Verify against the deployed binary, never the public source.** The
   public `solana-program-library` governance has DIVERGED from the
   GovER5 fork (this exact mistake is recorded in D-031→D-032; it cost a
   whole design). Re-derive enum orderings, account layouts, and
   behaviors from the dumped `.so` and from on-chain behavior.
3. **Separate evidence from belief.** A comment, a decision doc, or a
   prior test asserting X is a *hypothesis*, not evidence. Re-prove load-
   bearing claims yourself.
4. **Document everything.** Findings register (format in §10), every
   probe (even negative results — "tried X, refused because Y" is
   valuable), and update `REDTEAM.md`. Do not silently fix; flag, prove,
   then propose.
5. **No mainnet transactions, no fund movement, no key generation, no
   deploys.** This is a read/analyze/test engagement. If a finding needs
   on-chain confirmation that only mainnet can give, say so and stop at
   the boundary.

**Severity rubric** (assign to every finding):
- **Critical** — direct loss/lock of user funds, or execution of an
  instruction the DAO did not approve, reachable by an attacker.
- **High** — minority capture, veto bypass, fidelity break (what passes
  ≠ what executes), or guarded-menu escape, possibly requiring a
  precondition.
- **Medium** — griefing/DoS, economic edge that weakens a guarantee,
  recoverable fund-locking, or a broken invariant with limited impact.
- **Low** — defense-in-depth gaps, missing validation with no current
  exploit path, operational footguns.
- **Info** — hardening, clarity, test-quality, documentation drift.

---

## 1. System map & trust boundaries (orient before probing)

Build the mental model first; an audit that doesn't know the trust
boundaries finds only shallow bugs.

- **Custom on-chain code (the crown jewel):** `programs/proposal-gate/src/lib.rs`
  — the ONLY Rust we deploy. Everything else on-chain is an audited,
  pinned, immutable third-party binary (spl-governance fork, Squads v4,
  VSR, pump stack, Jito merkle distributor). The audit weight is heavily
  here.
- **Governance integration:** the gate CPIs the GovER5 fork for the full
  proposal lifecycle (create/insert/sign-off/cancel/deposit/set-realm-
  authority). Custody flows Realm → governance native-treasury PDA →
  sole member of a Squads multisig → vault PDA == pump creator (INV-1/7).
- **Off-chain (TypeScript):** SDK builders (`packages/sdk`), backend
  orchestrator + browser-signing seam + stores (`packages/backend`),
  keeper fee-sweeper (`packages/keeper`), Next.js app (`app`).
- **Human trust:** the launcher/upgrade-authority keys (Section 11), the
  council members, the keeper operator, the RPC provider.

Draw the boundary where **attacker-controlled bytes meet privileged
action**. The highest-value boundaries:
  (a) attacker-authored proposal bytes → gate validation → CPI to a
      gate-signed instruction;
  (b) attacker token account → gate requester-threshold parse;
  (c) attacker form input → backend → a signed launch transaction;
  (d) attacker proposal → what voters see (artifact) vs what executes.

---

## 2. Phase 0 — Reproduce the baseline (do this first, commit nothing)

1. Restore the toolchain (D-029): Anza `solana-cli 4.0.1`, platform-tools
   v1.53 (curl-fetch into `~/.cache/solana/v1.53/platform-tools/` — the
   proxy CA breaks the built-in downloader), `cargo-build-sbf`. Add
   `~/.local/share/solana/install/active_release/bin` to PATH.
2. `pnpm install`; build SDK + backend (`pnpm --filter @daofun/sdk build`,
   same for backend) so workspace `dist/` is fresh.
3. Run the FULL suite (`pnpm test`) and record the green baseline. Note
   the documented parallel-flake (a heavy bankrun suite can hit the 300s
   timeout; re-run the file alone before trusting a failure).
4. Rebuild the gate from source and confirm it byte-matches the committed
   fixture path (`tests/fixtures/proposal_gate.so.gz`); a fixture that
   doesn't match source is itself a Critical finding (you'd be auditing
   different code than ships).
5. Inventory: list every `#[derive(Accounts)]` struct, every public
   instruction, every `invoke_signed`, every `UncheckedAccount`, every
   manual byte-parse, and every pinned constant/byte-array in the gate.
   This list is your Phase-1 worklist.

---

## 3. Phase 1 — The on-chain program (`proposal-gate`), exhaustively

This is the bulk of the engagement. Go function by function, struct by
struct. For EACH item below, the question is always: *what does an
attacker control, and what stops the bad outcome?*

### 1a. Account validation & Anchor constraints
For every `Accounts` struct (`Initialize`, `Ratchet`, `ValidateTransaction`,
`GuardCreateProposal`, `GuardProposalAction`, `GuardSignOff`,
`DepositCouncil`, `ReleaseRealmAuthority`):
- **Every `UncheckedAccount`/`CHECK`:** what actually constrains it? An
  `address = …` against gate config? A PDA `seeds`+`bump`? A handler-side
  derive-and-compare? Or *nothing*? Enumerate each and try to substitute
  a malicious account. Specifically audit the gate's council TOR
  (`gate_tor`), the `proposal`, `proposal_transaction`, `realm_config`,
  `proposal_deposit`, `holding`, `gate_council_ata`, `governance_program`.
- **PDA seeds & bumps:** is every gate-owned PDA validated with the
  *stored* bump (not a re-found one)? Are seeds attacker-influenceable?
- **`has_one` / `address` constraints:** confirm `gate.realm`,
  `gate.governance`, `gate.community_mint`, `gate.council_mint` are bound
  everywhere they matter. Find any path that uses one of these without
  binding it.
- **`init` / reinit / `init_if_needed`:** can `initialize` be front-run
  or re-run (per-realm PDA — confirm the collision is a hard, loud
  abort, D-033/D-034)? Can `ProposalMeta` or `Clearance` be created with
  attacker-chosen contents?
- **Signer requirements:** is `requester` the only required human signer?
  Can an extra signer be injected? Is the gate PDA the *sole* program
  signer on every CPI?

### 1b. The CPI layer (highest-risk in the program)
The gate hand-builds `Instruction { accounts: vec![AccountMeta…], data }`
and calls `invoke_signed` with a **separately constructed** `Vec<AccountInfo>`
(the `cpi_infos()` helpers). **The account-meta list and the info list
must correspond exactly, in order and privilege.** A mismatch is a
classic, severe bug class.
- For EACH CPI (`guard_create_proposal`, `guard_insert_transaction`,
  `guard_sign_off`, `guard_cancel`, `deposit_council`,
  `release_realm_authority`): verify the `AccountMeta` ordering and
  signer/writable flags against the **deployed GovER5 binary's**
  expectations (re-derive from the dump / the 0.3.28 client the binary
  accepts — see Phase 2), AND verify the `cpi_infos()` `AccountInfo`
  vector matches that exact set. Off-by-one or a swapped writable flag
  here can let an attacker steer a gate-signed write.
- **Signer seeds:** `[b"gate", realm, bump]` — confirm the realm and bump
  are the gate's own (not attacker-supplied) on every `invoke_signed`.
- **The forwarded-bytes guarantee:** `guard_insert_transaction` validates
  `ix_bytes` then forwards them verbatim into the governance
  `InsertTransaction` data. Prove that the bytes *validated* are
  byte-identical to the bytes *forwarded* and *stored* — no
  reserialization, no truncation, no trailing-byte injection (the
  handler checks `r.exhausted()`; verify that actually covers the whole
  buffer and the governance program stores exactly these bytes).
- **CPI re-entrancy / depth:** can a whitelisted inner program CPI back
  into the gate or governance to reach a refused path indirectly?

### 1c. The validation engine (`validate_instruction_set`, `validate_vault_message`, `Reader`)
This parses **fully attacker-controlled bytes**. Fuzz it to death.
- **`Reader` bounds:** prove every `bytes/skip/u8/u16/u32/pubkey` is
  bounds-checked and cannot panic, over- or under-read. Property-test
  with random/truncated/oversized buffers. A panic is a DoS; a misread is
  potentially a validation bypass.
- **The Squads vault-message unwrap:** the offsets (8+1+1 skip, msg len,
  3 header bytes, smallVec keys, compiled-ix loop, ALT count). Confirm
  against `@sqds/multisig 2.1.4` `vaultTransactionCreate` AND against
  what the deployed Squads binary actually stores. Try: a message whose
  declared lengths disagree with actual; a program index out of range; an
  inner ix that points at a key the outer didn't whitelist; ALT count
  nonzero hidden behind a short read.
- **Discriminator handling:** `VAULT_TX_CREATE_DISC` /
  `TX_BUFFER_CREATE_DISC` — can an attacker craft a Squads instruction
  that is NEITHER (so the unwrap is skipped) yet still smuggles a foreign
  inner program? Can a non-Squads program on the whitelist carry a hidden
  CPI the engine never inspects?
- **The governance-self-call refusal (`check_program` guarded branch):**
  the gate hard-refuses any leg targeting `SPL_GOVERNANCE_ID` while
  guarded. Attack it: reach the governance program *indirectly* (via a
  whitelisted program that CPIs governance), via a Squads inner ix, via
  an ALT-hidden key, via the deprecated/versioned-tx Squads paths the
  fork supports (D-032 lists them). Is `SetRealmConfig`/`SetGovernanceConfig`
  truly unreachable from a guarded proposal?
- **Buffered/ALT refusal:** confirm both are refused on every path
  (outer and inner), and that the refusal can't be bypassed by mixing a
  plain leg with a buffered one.

### 1d. The front-door economic model
- **u64::MAX welding (`minCommunityTokensToCreateProposal`):** prove it
  is genuinely unreachable, not merely large. Re-examine VSR weight
  (digit-shift, lockup multiplier, saturation), `MintMaxVoteWeightSource`,
  and any addin path. Can a voter ever present a weight ≥ u64::MAX? Can
  the realm be reconfigured (it shouldn't — authority is the gate) to
  lower it? (The spike `tests/stage3-guarded-spike.integration.test.ts`
  asserts a 100%-supply depositor + delegate are refused — re-derive WHY
  on the binary, don't trust the assertion.)
- **Gate-seat exclusivity (H+1 vs `minCouncil`=H+1):** off-by-one hunt.
  Can H humans pool to H+1? Can a human acquire a 2nd council token
  (mint authority is null — confirm)? Can the gate seat's tokens be moved
  out from under it (Membership type — confirm non-withdrawable on the
  binary)? What if a council member is *also* the gate? What about 0 or 1
  human councils (degenerate `guardedVetoPercent`)?
- **Requester threshold parse (`require_requester_threshold`):** this
  hand-parses a token account at fixed offsets (mint 0..32, owner 32..64,
  amount 64..72, state byte 108). **Audit hard:**
    - Token-2022 accounts with extensions — do the base offsets still
      hold, or can an extension shift/lie? The gate accepts BOTH token
      programs (`TOKEN_PROGRAM` and `TOKEN_2022_PROGRAM`). (Note: the
      `TOKEN_2022_PROGRAM` const was wrong once and fixed mid-build —
      re-verify the byte array equals `TokenzQd…`.)
    - Owner check vs the on-chain account owner (program) vs the token
      account's `owner` field — both must be right.
    - The `state == 1` (initialized, not frozen) check — is a frozen or
      uninitialized account rejected? A closed account?
    - Can an attacker present someone else's account, a fake account
      owned by a look-alike program, or a CPI-confused account?
    - Does the check read `amount` of the COMMUNITY mint specifically?
- **`ProposalMeta` requester-gating:** only the recorded requester may
  insert/sign-off/cancel. Try to act on another requester's proposal;
  try to forge a meta; try to race two requesters on the same proposal
  PDA.

### 1e. Ratchet & realm-authority release
- **`ratchet`:** one-way (`new_mode > gate.mode`) and requires the
  **governance PDA** as signer (only signs via executed proposals).
  Prove no non-vote path can move the mode; prove it cannot go backward
  or skip into an invalid value; confirm `has_one = governance`.
- **`release_realm_authority`:** gated on `mode > guarded`,
  `SetRealmAuthority(SetChecked)` to `gate.governance`. Can it be called
  while still guarded? Can it hand authority to the wrong account
  (SetChecked should refuse — confirm on the binary)? Once released, can
  the gate still sign anything dangerous?

### 1f. State, storage, arithmetic
- **Gate immutability:** whitelist, mints, governance, realm,
  proposal_threshold — prove NO instruction mutates them after
  `initialize`. `mode` changes only via `ratchet`.
- **`InitSpace`/space:** confirm allocations match the serialized size
  (the test reads `mode` at byte offset 144 — verify the whole layout).
- **Arithmetic:** `overflow-checks = true` is set at the workspace
  profile — confirm it's actually compiled in for the SBF target, and
  audit every `checked_*`/`as`/index for overflow/truncation.

### 1g. Constants & identity
- Re-verify EVERY pinned byte-array pubkey against the base58 it claims
  (`SPL_GOVERNANCE_ID`, `SQUADS_V4_ID`, `TOKEN_PROGRAM`,
  `TOKEN_2022_PROGRAM`). One wrong byte = a program-confusion vuln.
- `declare_id!` vs the deploy keypair: post-mainnet-deploy the program ID
  must match `declare_id` and `GATE_PROGRAM_ID` in the SDK and the test
  fixture. Audit the deploy/ID-handling plan (D-029/D-034) for an ID
  mismatch that would silently route to the wrong/empty program.

---

## 4. Phase 2 — Re-verify the deployed-fork assumptions (GovER5)

D-031→D-032 are a cautionary tale: the public source diverged from the
deployed fork and a whole design was built on phantom behavior. **Re-prove
every fork assumption the gate depends on, against the dumped binary and
on-chain behavior — not the public repo, not the 0.3.28 client docs.**

- The CPI account orders the gate pins (CreateProposal v3,
  InsertTransaction, SignOffProposal, CancelProposal,
  DepositGoverningTokens, SetRealmAuthority): do they match what the
  deployed binary actually requires? (The 0.3.28 client is "the client
  the GATE 1 suites proved against this binary" — confirm that lineage,
  don't assume it.)
- `SetRealmAuthority(SetUnchecked)` parking on a non-signing PDA, and
  `SetChecked` refusing a non-governance authority — re-prove on the
  binary (the spike asserts the lockout via error `0x234`; re-derive).
- `minCommunityTokensToCreateProposal` / `minCouncilTokensToCreateProposal`
  enforcement semantics, and the veto-threshold comparison (`>=` vs `>`),
  which `guardedVetoPercent` relies on being robust to. Pin it.
- Vote tipping `Disabled`, the exit-window guarantee (INV-3), and that
  no required-signatory mechanism exists (D-032) — the gate's whole
  model depends on this absence; confirm it still holds in the dumped
  binary you're testing against.
- The Squads versioned-transaction / buffer suite the fork supports
  (D-032) — does any of it provide an alternate insert path that
  bypasses the gate's plain-wrap assumption?

---

## 5. Phase 3 — Governance capture & economic adversary

Re-run `REDTEAM.md` §1 adversarially (try to BREAK each "impossible"),
then push past it.
- **Flash capture / slow capture / setParam-as-weapon / veto bypass /
  mode-transition abuse** — reproduce the refusals on the binary, then
  attack the edges (boundary tiers, extreme voting windows, dust
  supplies, council collusion).
- **Guarded front-door (D-033 model):** the integration suite already
  tries the obvious bypasses (off-menu outer, smuggled inner, gov-leg,
  direct-insert bypass). Invent NEW ones: gate-seat key compromise; a
  council member who is also a community whale; the
  outstanding-proposal-cap DoS (the single gate TOR caps active
  proposals realm-wide — quantify the griefing cost and whether cancel
  fully releases slots); proposal-deposit exhaustion; rent-exemption
  griefing on gate-created accounts.
- **The ratchet exit:** once ratcheted to council, is the realm a clean
  standard DAO, or does a vestigial gate / leftover authority leave a
  capture path? Re-audit the full exit (ratchet → release → arbitrary
  inserts → config restore) for a state where the gate still has power it
  shouldn't.
- **MEV / ordering / front-running:** the multi-tx launch ceremony
  (D-033/D-034: gate-init front-run aborts loudly — confirm it can't be
  front-run into a *silent* wrong state); proposal/vote ordering;
  keeper-collect races.

## 6. Phase 4 — Execution fidelity (INV-9 / INV-10)

- Prove **what passes == what executes**, byte-identical, under
  adversarial inputs. The artifact hash is `descriptionLink` (D-017) and
  is recomputed from chain ProposalTransactions by the UI. Attack the
  equality: can the published artifact differ from the chain bytes while
  the badge still shows green? Re-audit the Squads privilege-
  normalization fix (D-027) — the bug that made conflicting-flag inner
  sets publish a permanently-mismatching hash. Can a crafted inner set
  still desync publish-time vs chain-side hashing?
- INV-10: are undecodable instructions flagged, never hidden? Can an
  attacker craft a proposal whose decoded summary is misleading
  (decoder gaps, ExecutionAdapter unwrap hiding the real effect)?
- `detectProposalAnomalies` (backend): does it actually catch
  hash-mismatch / missing-hash / zero-hold-up / no-instructions, or can
  they be slipped past?

## 7. Phase 5 — Off-chain stack (SDK / backend / keeper / app)

- **Signer-set hygiene (INV-7 spirit):** prove no platform/backend key
  can ever enter a *user's* signer set. Audit `tx-builder.ts` (browser-
  signing, D-028): the backend builds UNSIGNED txs with the wallet as
  sole signer — confirm there's no path to inject an extra signer or a
  hidden instruction the user doesn't see before signing.
- **Key custody (Section 11, D-034):** the new `LaunchService` holds the
  launcher keypair (persistent) + ephemeral per-launch mint/createKey/
  council-mint keys. Audit: are ephemeral keys ever logged/persisted? Can
  a crash strand funds or leave a half-custodied DAO? Is the launcher key
  loaded safely? Does `config.ts` truly halt-until-funded, and is the
  `GATE3_OVERRIDE_ACK` gate as loud/unbypassable as claimed?
- **Keeper:** INV-2 (collect needs no creator signature; keeper signs
  only as fee-payer — assert the signer set), INV-8 (gross sweep, no
  skim), D-009 rent-floor handling, escalation/observability. Can a
  malicious keeper steal, skim, or grief? Can a third party redirect a
  collect?
- **`distribute` / holder snapshot:** Merkle tree soundness (no double-
  claim, Σ claims ≤ funded, clawback returns remainder), snapshot
  integrity (RPC/DAS source trust, can a holder inflate their share?).
- **HTTP API & stores:** input validation on `/launches`, `/snapshots`,
  `/chain/txs`; the launch-form server re-validation matches the client
  contract; SQLite usage (injection, concurrent launches, resumability
  correctness in `SqliteLaunchStore`).
- **App:** does the UI ever show a user one thing and sign another? Is
  guarded correctly UNSELECTABLE until the program is actually on
  mainnet? Wallet-standard integration.

## 8. Phase 6 — Supply chain, build, IDL

- `pnpm audit --prod`; reconcile against `REDTEAM.md §5.4` dispositions.
  Are pinned versions (`VERSIONS.md`) still the audited ones?
- Build reproducibility: does `cargo-build-sbf` from source reproduce the
  committed fixture? Are all `tests/fixtures/*.so.gz` the claimed
  mainnet binaries (hash them; compare to on-chain program data where
  possible)?
- IDL / metadata exposure on deploy; the program-id keypair handling
  (`programs/target/` gitignored — confirm no private key is committed
  anywhere, scan git history).

## 9. Phase 7 — Operational & deployment; Phase 8 — Test-suite quality

**Operational (Phase 7):**
- Upgrade authority custody (Section 11): who can upgrade the deployed
  gate? Is the authority a multisig, never a hot key? What's the
  abuse case if it's compromised (the gate holds realm authority on every
  guarded DAO — an upgrade could rewrite all of them)? This is likely the
  single highest-impact operational finding — treat it as such.
- Incident response: can the program be paused/closed? Can realm
  authority be recovered if the gate misbehaves? Is there a kill-switch,
  and does its existence create its own capture risk?
- The mainnet deploy parameters (D-034: `--max-len`, upgrade authority,
  the `GATE3_OVERRIDE_ACK` audit override) — is the override
  appropriately loud and logged? Is deploying unaudited code the right
  call (state it plainly in the go/no-go)?
- RPC trust, rate-limiting (D-026), and reliance on a single provider.

**Test-suite quality (Phase 8) — audit the audit:**
- Do the "real binary" tests actually load the real binaries (not a
  stub)? Are any assertions tautological or mocked-away?
- Coverage gaps: enumerate what is NOT tested (e.g., multi-proposal
  concurrency, Token-2022 community mints in guarded, the exact CPI
  account orders under malformed inputs).
- Bankrun-vs-mainnet fidelity gap: what does bankrun NOT model that
  mainnet does (compute budget, rent dynamics, slot/clock, ALT
  activation) and could that hide a bug?

---

## 10. Deliverables & exit criteria

Produce, committed to the repo on the audit branch:

1. **`audit/AUDIT-FINDINGS.md`** — the register. One entry per finding:
   ```
   ### [SEVERITY] <short title>  (ID: AUD-NN)
   - Component / file:line
   - Class: (e.g. account-substitution, CPI-meta-mismatch, econ-capture…)
   - Precondition / attacker model
   - Impact (what fund/approval/guarantee breaks)
   - Reproduction: <path to the failing test + how to run>
   - Evidence: logs / on-chain refs / binary findings
   - Remediation: concrete, with the trade-off
   - Status: open / mitigated-in-PR / accepted-risk (who accepted)
   ```
   Include **negative results** too (probes that found nothing) — they
   are the proof of coverage.
2. **Reproduction tests** under `tests/` (and `packages/*/test`) — every
   confirmed finding has one; every "safe" verdict on a load-bearing
   invariant has a regression test that fails if the protection is
   removed.
3. **Updated `REDTEAM.md`** — fold new scenarios and verdicts in.
4. **An INV-1..INV-11 traceability table** — each invariant: where
   enforced (file:line), where tested, and your verdict on whether it can
   be violated.
5. **Go / no-go for mainnet** — a plain-English recommendation with the
   top risks, the audit-override consequence (deploying unaudited custom
   code, D-034), and the minimum set of fixes required before deploy.

**Exit criteria:** every public instruction of the gate has been
adversarially exercised; every `UncheckedAccount` has a documented
constraint or a finding; every CPI's meta/info correspondence is
verified against the binary; the front-door economic model and the
fidelity guarantee each have a fresh proof or a finding; the off-chain
signer-set and key-custody claims are proven; and the go/no-go is
defensible to an external auditor.

---

## 11. Seed list — specific things to look at first (auditor's hunch list)

Not exhaustive; these are the spots most likely to hide a real bug given
how the code was built. Start here, then go systematic.
- **CPI `AccountMeta` list ↔ `cpi_infos()` correspondence** in every gate
  instruction (order + writable/signer flags vs the deployed binary).
- **The requester token-account hand-parse** under Token-2022 with
  extensions (offset assumptions), frozen/closed accounts, and wrong-mint
  accounts.
- **Indirect reach of the governance program** from a guarded proposal
  (via a whitelisted program's CPI, a Squads inner ix, the fork's
  versioned-tx paths, or an ALT-hidden key).
- **u64::MAX reachability** through any VSR/max-vote-weight path.
- **The `Reader` on malformed Squads vault messages** (length
  disagreements, OOB program indices, hidden ALTs) — fuzz it.
- **Off-by-one in gate-seat vs minCouncil** and degenerate council sizes
  in `guardedVetoPercent`.
- **`declare_id` / `GATE_PROGRAM_ID` / fixture** consistency after a real
  deploy (D-034) — an ID drift routes to the wrong program silently.
- **Upgrade-authority blast radius** — one upgrade rewrites every guarded
  DAO's gatekeeper.
- **Ephemeral launch-key custody** — crash/stranding/half-custody states.
- **Fork-assumption drift** — anything the gate pins from the 0.3.28
  client or public source that you haven't re-proven on the dumped `.so`.
