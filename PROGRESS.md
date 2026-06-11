# PROGRESS.md — running log (spec Section 13 checklist)

## Stage 0

- [x] 13.1 Scaffold repo / pnpm workspaces / CI; pin versions → VERSIONS.md
  - workspaces: packages/{sdk,keeper,backend}, app (placeholder until 13.7), scripts, tests
  - CI: `.github/workflows/ci.yml` — unit job live; integration job stubbed for Stage 1 (needs solana-test-validator with mainnet clones)
  - lockfile committed; exact pins for all fund-path SDKs
- [x] 13.2 `scripts/init-wallets.ts` + tests green (7 tests, `tests/init-wallets.test.ts`)
- [~] 13.3 Verify-and-record (DECISIONS.md): PDA seeds + program IDs CONFIRMED
      (D-003, 13 green tests); spec-breaking finding D-001 (realm-name seed
      length) fixed and flagged for operator; remaining (verify) items listed
      as Open in DECISIONS.md, due at first use per component
- [x] 13.4 GATE 0a → **PASS on mainnet 2026-06-11** (operator-funded
      override, D-008) — vault-as-creator + permissionless collect proven
      live; evidence in GATES.md; rent-floor lessons in D-009; awaiting
      formal operator sign-off line in GATES.md
- [ ] GATE 0b (soft) — note D-004: v2 creates are already Token-2022; re-scope
- [ ] GATE 0c (soft) — fee shares at launch for PDA creator

## Stage 1 — SDK started early by operator decision (2026-06-11), while
## GATE 0a awaits funding. No fund-moving devnet txs before 0a sign-off.

- [x] 13.5a types (spec S4; amended D-005)
- [x] 13.5b PumpFunRail — tests first (8 tests: INV-1 create-arg/non-signer,
      INV-2 collect signer-set, GATE 0c gating, oracle-pinned vault PDAs)
- [x] 13.5c Treasury — tests first (6 tests: sole-member ix decode, threshold
      1, configAuthority null, off-curve vault, createKey signer shape)
- [x] Section 5 matrix resolution — tests first (7 tests incl. the v2.0
      mode/tier resolution rule and checked threshold math)
- [x] 13.5d Governance builders — tests first (9 tests: advance-derivation
      through real builders, VSR baseline-0 byte layout, mode-structural
      council mint, realm authority -> governance, registrar-before-transfer
      ordering). VSR IDL resolved + vendored (D-010); veto config verified
      (D-011); open spec params fixed (D-012). On-chain legs await the
      Stage 1 integration suite (validator with clones).
- [x] 13.5e ExecutionAdapter builders — tests first (7 tests: 4-step Squads
      chain, member signs every step, vault never tx-level signer,
      unwrap(wrap(x)) == x, plumbing hidden from decoder). Full-path /
      CU-split tests are integration-bound.
- [x] 13.6a keeper — tests first (10 tests: gross accounting INV-8,
      idempotency, INV-2 refusal, retry/backoff, u64-bound math INV-6,
      per-vault failure isolation); service wiring rent-floor-aware (D-009).
      AMM venue accrual open until a graduated token exists to test against.
- [~] 13.6b action menu (6.8): grant + burn shipped tests-first (5 tests,
      bounds + declared-account-set). buyback / provideLiquidity /
      distribute / setParam blocked on open verify items (PumpSwap pool
      ixs, merkle distributor ID, param registry).
- [x] 13.6c backend orchestrator (6.6): step machine (5 tests) + concrete
      launch steps (6 tests: exact fee, INV-1 creator plumbing, resume
      after token creation, INV-5/INV-7 halt-on-violation) + 12.3 artifact
      store: hash (5 tests) + sqlite persistence via node:sqlite (4 tests).
      Remaining for 6.6: thin HTTP API over these (wiring only).
- [~] 13.7 app: UI logic layer shipped tests-first (9 tests: floor
      enforcement incl. stricter-only overrides, cypherpunk single +
      sovereign double confirmations, guarded unselectable, hash badge
      verified/mismatch/missing, hold-up-gated execute button). Remaining:
      Next.js shell rendering these results + Playwright e2e.
- [~] 13.8 GATE 1: mainnet partial (sovereign) IN PROGRESS, operator-funded
      (D-008). DAO + Token-2022 deposits live; INV-7 verified on-chain;
      critical findings D-013 (VSR can't do Token-2022 -> no-addin realms
      at MVP), D-015 (proposal deposit default). Proposal/vote/execute legs
      pending top-up. Council/cypherpunk matrix + clock-warp behavior still
      need the integration suite (validator with clones) or devnet.
