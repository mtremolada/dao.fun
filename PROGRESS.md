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
- [ ] 13.4 GATE 0a script → evidence → STOP for operator sign-off
  - script ready: `scripts/devnet-validate-creator.ts` (`pnpm gate:0a`)
  - status: see GATES.md
- [ ] GATE 0b (soft) — note D-004: v2 creates are already Token-2022; re-scope
- [ ] GATE 0c (soft) — fee shares at launch for PDA creator

## Stage 1 — not started (blocked on GATE 0a sign-off)
