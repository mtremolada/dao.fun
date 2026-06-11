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
- [x] GATE 0b (soft) → **DETERMINED 2026-06-11 on real binaries**
      (evidence in GATES.md): plain Token-2022 launches AND trades on the
      curve (buy + full sell-back, creator fees accrue — hermetic
      replication of the GATE 0a live result); transfer-fee extensions
      are structurally impossible (pump initializes the mint inside
      create_v2 and refuses a pre-existing mint account) → dropped from
      scope per the gate's fail branch. Stage-0 gates are now all
      determined; sign-offs pending.
- [x] GATE 0c (soft) → **DETERMINED 2026-06-11 on real binaries** (D-019,
      evidence in GATES.md): at-launch fee shares for a PDA creator are
      impossible (PumpFees requires the creator as the paying signer) —
      MVP protocol revenue = flat launch fee, per the spec fallback. The
      DAO CAN configure its own fee sharing post-launch via the custody
      chain (verified end-to-end: atomic create+set {vault 90/protocol
      10} through proposal -> vote -> hold-up -> execute). Forced sdk
      machinery: buffered ExecutionAdapter wrapping (wrapBuffered +
      buffered unwrap), auto-switch in buildProposeIxs, v0+ALT insert
      packing, 400k CU floor for stacked executes.

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
      bounds + declared-account-set). buyback (curve venue) shipped
      tests-first (3 unit tests: vault-as-only-inner-signer, no ATA-create
      inside the proposal per the D-019 size ceiling, D-009 bounds) and
      PROVEN end-to-end on the real binaries
      (tests/action-buyback.integration.test.ts): the DAO votes to buy its
      own token with vault SOL through the buffered custody chain; the
      vault receives the tokens and — being the coin creator — the buy's
      creator fee flows back to its own creator vault. Still blocked:
      post-graduation buyback + provideLiquidity (PumpSwap pool ixs),
      distribute (merkle distributor ID), setParam (param registry).
- [x] 13.6c backend orchestrator (6.6): step machine (5 tests) + concrete
      launch steps (6 tests: exact fee, INV-1 creator plumbing, resume
      after token creation, INV-5/INV-7 halt-on-violation) + 12.3 artifact
      store: hash (5 tests) + sqlite persistence via node:sqlite (4 tests)
      + thin HTTP API (7 tests: server-side re-validation with the shared
      launch-form contract, resumable failed state over the wire, artifact
      lookups keyed proposal+hash). launch-form contract moved to sdk
      (app re-exports) so client and server use the SAME functions.
- [x] 13.7 app: UI logic layer shipped tests-first (9 unit tests: floor
      enforcement incl. stricter-only overrides, cypherpunk single +
      sovereign double confirmations, guarded unselectable, hash badge
      verified/mismatch/missing, hold-up-gated execute button) + Next.js
      shell (mode selection, launch form posting to the backend API via
      same-origin /api rewrite, proposal view) + 7 Playwright e2e tests
      written first and run against the REAL createApiHandler (stubbed
      steps): guarded unselectable, sovereign double-confirm, sub-floor
      override rejected client-side w/ floor error, stricter accepted,
      launch round-trip renders completed state, hash badge
      verified/red-mismatch/missing, execute disabled until hold-up
      elapses. Client bundle stays ~105 kB: the form imports
      "@daofun/sdk/launch-form" (TS-source subpath export) so chain deps
      never reach the browser. Chain reader + dashboard shipped
      tests-first (backend: ChainReader seam, /chain/* routes, 12 unit
      tests; app: chain-fed proposal view w/ veto status + /dao/[realm]
      dashboard, 3 more e2e = 10 total) and verified LIVE read-only
      against the GATE 1 mainnet DAO: badge verified against the
      chain-recomputed hash, dashboard shows the real sweep history
      (conventions in D-017). Wallet adapter deliberately deferred
      (D-017: launch is backend-orchestrated; browser signing is
      Stage 2).
- [x] Stage 1 polish from the gate findings (tests-first): treasury
      `rentCollector = nativeTreasury` so Squads execution rent returns to
      the DAO (D-016; accepted by the real program in the bankrun suite);
      launch flow `prefund-treasury` step funds the treasury floor + one
      execution's rent headroom (D-016); sdk `buildProposeIxs` is the
      production propose path — ExecutionAdapter wrapping, per-transaction
      hold-up (INV-3), and `descriptionLink == innerInstructionSetHash`
      (D-017, verified on chain state); canonical INV-9 hash moved to the
      sdk, backend re-exports. The bankrun matrix legs now drive proposals
      through this builder.
- [x] 13.8 GATE 1 mode matrix — all technical legs PASS; awaiting
      operator sign-off. (a) Sovereign leg PASS live on mainnet,
      operator-funded (D-008): full lifecycle proposal -> vote -> finalize
      -> execute on a fresh DAO under production sovereign/micro params
      (only deviation: 1h baseVotingTime, the program minimum).
      INV-3/INV-5/INV-7 verified on-chain; INV-9 verified by re-reading
      the wrapped ixs FROM CHAIN and matching the artifact hash; custody
      chain moved real lamports (Squads vault 890,880 -> 0 via
      governance-executed 4-step chain). Findings D-013/D-015/D-016.
      (b) Council, cypherpunk, and VSR legs PASS against the REAL mainnet
      binaries in solana-bankrun (tests/gate1-matrix.integration.test.ts,
      `pnpm test:integration`, hermetic in CI): council veto -> Vetoed,
      execution refused (INV-4) while a non-vetoed proposal executes after
      the 72h hold-up (INV-3); cypherpunk realm structurally council-free;
      VSR baseline-0 lockup weighting incl. clock-warp decay; D-013
      re-verified on clean evidence. Two sdk bugs found+fixed (D-018):
      council-mint-before-realm ordering, VSR registrar seed order.
      Phase-1 realm's proposal leg remains blocked at its pre-fix 0.102
      deposit (resumable; optional).
