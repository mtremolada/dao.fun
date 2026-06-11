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
- [~] 13.6c backend orchestrator (6.6): step machine shipped tests-first
      (5 tests: per-step idempotency keys, resumable partial failure,
      resume-only-missing, no-op re-resume, persist-every-step) + 12.3
      artifact store (5 tests: deterministic / order- / flag-sensitive
      instruction-set hash, keyed retrieval). Remaining: the concrete chain
      steps (treasury/fee/token/dao txs via the sdk builders) + sqlite
      store + HTTP API — these are wiring over already-tested builders.
- [ ] 13.7 app
- [ ] 13.8 GATE 1 mode matrix on devnet (needs faucet or operator funding;
      integration suites also want solana-test-validator with clones)
