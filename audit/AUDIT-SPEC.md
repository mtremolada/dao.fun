# AUDIT-SPEC.md — adversarial security audit plan (reconstructed)

> **Provenance note.** The audit task referenced `audit/AUDIT-SPEC.md` and
> `DECISIONS.md` "through D-034", but neither existed in the repository or its
> git history at audit time (DECISIONS.md stops at D-032; there was no `audit/`
> directory). Rather than block, this spec was reconstructed from the task
> description and the authoritative project docs (SPEC.md v2.0, DECISIONS.md
> D-001..D-032, REDTEAM.md, GATES.md, CLAUDE.md). The 8 phases and the
> "Phase 11 hunch list" below are this reconstruction; if the operator has the
> original AUDIT-SPEC, diff it against this and re-run any phase it scopes
> differently. The findings themselves stand on their own evidence (failing
> tests on real binaries), independent of how the phases are numbered.

## Doctrine

- **Adversarial.** Assume every documented "safe" verdict is wrong until a test
  on the **real deployed binaries** (bankrun) says otherwise.
- **Prove, don't assert.** Every confirmed finding gets a failing/repro test on
  the real binaries. Every "safe" verdict on a load-bearing invariant gets a
  regression test so it cannot silently rot.
- **Flag → prove → propose. Never fix silently.** No fund-path behaviour is
  changed without a finding entry and a test pinning the change.
- **No mainnet.** No mainnet transactions, no key generation, no deploys. All
  evidence is hermetic (bankrun + committed fixtures).
- All output: `audit/AUDIT-FINDINGS.md`, the repro/regression tests, an updated
  `REDTEAM.md`, an INV-1..11 traceability table, and a plain-English go/no-go.

## Phases

- **Phase 0 — Reproduce the green baseline.** Build; run unit + integration;
  record counts; confirm eslint + tsc. Nothing proceeds on a red tree.
- **Phase 1 — Custody & launch (INV-1, INV-5, INV-7).** The advance-derivation
  rule, the Squads single-member vault, the orchestrator launch sequence and
  its resume/idempotency. Does the *product's* launch path actually produce the
  custody shape the gates proved with one-off scripts?
- **Phase 2 — Fee collection & keeper (INV-2, INV-8).** Permissionless collect,
  no-skim accounting, keeper signer refusal, venue consolidation.
- **Phase 3 — Governance params & anti-capture (INV-3, INV-4, INV-11).** Tier
  floors, hold-up gating, veto surface, the ratchet, and — critically — whether
  the red-team's capture model matches the *shipping* governance configuration.
- **Phase 4 — Execution fidelity (INV-9, INV-10).** The publish-time vs
  chain-side instruction-set hash across every wrapped shape; the decode/anomaly
  surface.
- **Phase 5 — Action menu fund bounds (spec 6.8).** grant/burn/buyback/AMM/
  distribute/setParam: bounds, account-set containment, merkle soundness, and
  the setParam ratchet-by-omission.
- **Phase 6 — Stage 3 proposal-gate (spec 6.9).** Out of MVP scope (WIP), but
  reviewed for the byte-reader, the ratchet direction, and the validation
  engine's parse correctness.
- **Phase 7 — Off-chain surface.** Backend API (auth, input validation,
  trust boundaries), snapshot math (INV-6), dependency posture, repo hygiene
  (eslint/tsc).
- **Phase 8 — Synthesis.** Findings, INV traceability, mainnet go/no-go.

## Phase 11 — initial hunch list (pursued first, per the task)

Targets chosen by reading the fund-path code adversarially before going
systematic. Outcome of each is recorded in AUDIT-FINDINGS.md.

1. **Orchestrator vs Token-2022.** Every proven launch (mainnet scripts, bankrun
   harness) passes `communityVoterWeightAddin: null` + a token-program retarget
   (D-013). Does the backend orchestrator (`buildLaunchSteps`)? → **F-1 (HIGH).**
2. **Anti-capture model vs shipping config.** REDTEAM grounds capture-resistance
   in VSR zero-weight/lockup, but production is no-addin (D-013). Is the voter
   actually locked through the drain? → **F-2 (MEDIUM).**
3. **setParam ratchet-by-omission.** Does `new GovernanceConfig({...current})`
   truly preserve the veto thresholds / tipping / cool-off / deposit exemption,
   or can a field silently flip? → **SAFE**, now fully regression-pinned.
4. **INV-9 hash across direct-leg-only / buffered / staged shapes.** The
   chain-side recompute is only integration-tested for plain vault chains. Do
   the other three shapes match publish-time? → **SAFE**, now regression-pinned.
5. **`computeInstructionSetHash` canonicality.** Single-byte account-count
   prefix. → **F-4 (LOW/INFO).**
6. **buyback `associatedUserAccountInfo` placeholder.** Wrong account type
   passed to suppress ATA creation. → **F-5 (LOW/INFO).**
7. **Launch-fee ordering.** Fee charged before the DAO is proven to stand up. →
   **F-3 (LOW)**, compounds F-1.
8. **Merkle distributor soundness / keeper skim / raw vault theft.** → **SAFE**
   (already pinned on the real binaries; re-confirmed).
