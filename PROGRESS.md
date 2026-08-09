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
- [x] 13.6a keeper — tests first (14 tests: gross accounting INV-8,
      idempotency, INV-2 refusal, retry/backoff, u64-bound math INV-6,
      per-vault failure isolation, two-venue accrual); service wiring
      rent-floor-aware (D-009). AMM venue CLOSED (D-023): the keeper
      consolidates post-graduation WSOL into the curve creator vault
      (transfer_creator_fees_to_pump_v2, payer-only signer) and one curve
      collect sweeps both venues as native SOL — the DAO never custodies
      WSOL. Rail builders + venue composition unit-tested (7 new sdk
      tests) and PROVEN end-to-end on the real binaries
      (tests/action-amm.integration.test.ts phase 4: real sweepVault core,
      keeper as only signer, vault credited, idempotent re-sweep).
- [x] 13.6b action menu (6.8): grant + burn shipped tests-first (5 tests,
      bounds + declared-account-set). buyback (curve venue) shipped
      tests-first (3 unit tests: vault-as-only-inner-signer, no ATA-create
      inside the proposal per the D-019 size ceiling, D-009 bounds) and
      PROVEN end-to-end on the real binaries
      (tests/action-buyback.integration.test.ts): the DAO votes to buy its
      own token with vault SOL through the buffered custody chain; the
      vault receives the tokens and — being the coin creator — the buy's
      creator fee flows back to its own creator vault. Post-graduation
      buyback (AMM venue) + provideLiquidity shipped tests-first (8 unit
      tests) on the STAGED two-leg design (D-021/D-022: vault legs through
      the custody chain stage funds to the native treasury; direct legs —
      new buildProposeIxs `directIxs`, treasury-signed via governance —
      act on the PumpSwap pool and return the proceeds to the vault) and
      PROVEN end-to-end on the real binaries
      (tests/action-amm.integration.test.ts): a whale completes the curve,
      ANYONE migrates (permissionless migrate_v2), pool.coinCreator ==
      vault survives graduation, then both actions execute by vote + 72h
      hold-up with final custody back in the vault. distribute shipped
      tests-first (14 unit tests: jito-compatible tree + proofs,
      builders, bounds, declared-account-set) on the IMMUTABLE mainnet
      merkle distributor (D-024) and PROVEN end-to-end on the real binary
      (tests/action-distribute.integration.test.ts): one proposal creates
      + funds the distributor with the root hash-pinned, holders claim
      with OUR proofs against the REAL verifier, double-claims and
      tampered amounts refused, permissionless clawback returns the
      remainder to the vault, books close exactly. setParam shipped
      tests-first (5 unit tests) on the whitelisted-param registry
      (D-025: quorum/hold-up/threshold/baseVotingTime within mode-resolved
      tier floors; ratchet by omission — the veto surface is unreachable)
      and PROVEN end-to-end on the real binary
      (tests/action-setparam.integration.test.ts): direct-leg proposal
      (governance PDA invoke_signed by ExecuteTransaction), 72h -> 96h by
      vote, non-target config byte-identical, and the NEW floor binds
      inserts and execution timing. The action menu is COMPLETE
      (on-chain byte-enforcement of the menu arrives with Stage 3's
      proposal-gate). distribute inputs: holder-snapshot service shipped
      tests-first (D-026: sdk proRataShares + backend RPC/DAS sources +
      POST /snapshots; loud top-20 fallback for the index-excluded public
      RPC, verified live).
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
      (conventions in D-017). Browser signing SHIPPED (D-028, closing the
      D-017 deferral): server-built unsigned txs (deposit + cast-vote,
      oracle-pinned; wallet = fee payer and only signer) over a minimal
      wallet-standard client — zero chain deps in the bundle; proven on
      the real governance binary (wallet-vote.integration.test.ts: the
      raw-bytes-signed vote counts exactly and finalizes the proposal)
      and e2e with a fake wallet-standard wallet (signed-bytes
      round-trip verified by the stub server, 12 e2e total).
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
- [x] 13.8 GATE 1 mode matrix — all technical legs PASS; operator
      signed off 2026-06-11 (GATES.md). (a) Sovereign leg PASS live on mainnet,
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

## Stage 2

- [x] 13.9 Property + fuzz + CU suites; Sec3 scan; observability;
      red-team report -> GATE 2 (technical legs determined 2026-06-12,
      evidence in GATES.md; operator sign-off pending):
      - property suite (fast-check over the REAL resolution + VSR weight
        code): flash-capture entry gate, Beanstalk impossibility, the
        hit-and-run lockup-vs-notice dichotomy, sovereign-0 exclusivity.
      - fuzz suite: u64-bound share math, merkle proof soundness, grant
        bounds, wrap/unwrap roundtrip — FOUND and fixed the
        privilege-normalization hash bug (D-027): buildProposeIxs now
        hashes the round-tripped effective set, so the published INV-9
        hash equals the chain recomputation BY CONSTRUCTION.
      - CU suite on the real binaries: every executed governance tx
        (custody chain, direct leg, distribute chain) <= 36.9% of the
        400k limit — clears the spec's 85% ceiling with margin.
      - Sec3: vacuous in MVP (zero custom on-chain programs; re-arms at
        Stage 3); pnpm audit run, bn.js bumped 5.2.2 -> 5.2.3, residual
        findings dispositioned (REDTEAM.md §5.4).
      - observability: KeeperMonitor + runMonitoredTick (escalation on
        repeated failure, bigint counters, balance gauges) and
        detectProposalAnomalies surfaced on /chain/proposals.
      - REDTEAM.md: no capture path on micro-tier in either MVP mode;
        residual risks dispositioned with mitigations.

## Stage 3

- [~] 13.10 launch-coordinator + proposal-gate: BUILD PIPELINE PROVEN
      (D-029: cargo build-sbf 4.0.0 / platform-tools v1.53 / anchor-lang
      0.30.1, overflow-checks=on at the workspace profile; fixtures
      committed gzipped so CI needs no Rust toolchain). proposal-gate v1
      SHIPPED (D-030, tests/stage3-gate.integration.test.ts on real
      binaries + our artifact): on-chain validation engine — parses real
      ProposalTransactionV2 accounts with a bounds-checked reader,
      unwraps the Squads vaultTransactionCreate message on-chain, clears
      menu proposals and REFUSES off-whitelist programs in outer legs
      AND smuggled inside the vault-signed inner set (buffered/ALT
      refused by design) — plus the structural INV-11 ratchet (one-way,
      governance-signed = vote-only; reverse leg refused in the same
      proposal). FINDING D-032 (binary verification, this is why we verify): the
      deployed GovER5 fork (v3.1.4) has NO required-signatory mechanism
      at all — the planned gate-sign-off path is abandoned. Guarded
      enforcement redesigns onto the realm-authority + proposal-creation
      gating path (operator decision pending); the D-030 validation
      engine + ratchet stand. MVP scope unchanged (Council + Cypherpunk).

## Launchpad (SPEC-LAUNCHPAD.md v1.0 — native curve + Raydium graduation)

Branch: `claude/solana-launchpad-bonding-curve-lqx3dd`.

- [x] **L0 — spec, pins, fixtures, foreign-binary verification** (no fund
      logic yet, by design):
      - SPEC-LAUNCHPAD.md v1.0 written (economics profiles, program
        contract, 24 named invariants, component contracts, gates);
        SPEC.md §14 pointer (v2.1); D-033 (scope + the four locked operator
        decisions + derived choices), D-034 (CPMM binary verification),
        D-035 (build pipeline + toolchain drift); VERSIONS.md launchpad
        section; research corpus committed under `research/launchpad/`.
      - Fixtures dumped with provenance: `cpmm.so.gz` at deploy slot
        425,801,539 (the dump script now REFUSES anything older than the
        verified slot), `mpl_token_metadata.so.gz`, `cpmm-accounts.json`
        (AmmConfig 0 + wSOL fee receiver + native mint), and
        `fixture-slots.json` recording which deployment each came from.
      - **CPMM interface verified against the DEPLOYED binary**
        (tests/launchpad-cpmm-verify.integration.test.ts, 5 tests):
        authority PDA seed, AmmConfig byte layout, permissionless plain
        `initialize`, the non-canonical-signing-pool_state path that makes
        graduation unsquattable, wrong-sort-order refusal, and the exact
        192,156,720-lamport migration cost. FOUND: the 100 withheld LP
        units are never minted, so a fully burned pool reads supply 0 —
        our first draft asserted 100 and failed, which is why this leg
        runs before Phase 2 (D-034).
      - **Build pipeline proven** (tests/launchpad-build.integration.test.ts,
        3 tests): `programs/launchpad-curve` scaffold compiles under
        cargo-build-sbf 4.1.0 / platform-tools v1.54 WITH the
        `raydium-cpmm-cpi` graduation crate linked (the plan's headline
        risk, retired on day one), loads in the same bankrun harness as the
        deployed binaries, and its config PDA decodes at the exact offsets
        the SDK will read; re-init refused; fee band enforced on both
        bounds.
- [x] **L1 — curve math in TS, property tests first** (21 tests,
      packages/sdk/test/curve-math.property.test.ts written before
      src/curve-math.ts): constant product over virtual reserves, rounding
      in the curve's favour on both sides (buy cost ceils, sell proceeds
      floor, fees ceil). Invariants proven: ROUND-BUY, ROUND-SELL,
      K-NONDECREASING (both directions), U128-WIDEN, RESERVE-CAP,
      SELL-NO-UNDERFLOW, SOL-CONSERVATION, COMPLETE-MONOTONE,
      MONOTONIC-PRICE, ROUNDTRIP-NONPROFIT, FEE-FLOOR/CAP,
      GRAD-COVERS-COST. Completion raise is DERIVED and pinned:
      85,005,359,057 lamports (pump-classic) / 2,833,511,969
      (devnet-scaled) — the plan's 2,833,511,968 was the floor of a
      division our ceil-rounding turns into ...969.
      FOUND by the fee property: at a 1-lamport curve cost the total fee
      is 1 lamport and cannot be split two ways, so the creator's share
      floors to zero. INV-FEE-FLOOR means "no free trades", not "both
      parties always paid"; the protocol absorbs the remainder
      deterministically and the test now says so.
      `tokensForSolInput` (the trade panel's inversion) binary-searches
      against the real quote function rather than a closed form, so it
      can never drift from what the buy actually charges.
- [x] **L2 — launchpad-curve program: trading AND graduation COMPLETE**
      (tests/launchpad-curve.integration.test.ts, 6 passing;
      tests/launchpad-build.integration.test.ts, 5 passing;
      tests/launchpad-cpmm-verify.integration.test.ts, 5 passing — all against
      the real CPMM + Metaplex binaries):
      - SHIPPED and proven: `initialize_config` / `update_config` (fee band
        and INV-GRAD-COVERS-COST enforced, authority-gated, Raydium
        addresses immutable after init, exact byte layout pinned),
        `create_coin` (full supply escrowed in the curve vault, mint AND
        freeze authority already gone, immutable Metaplex metadata,
        INV-CREATOR-ARG — the creator never signs), `buy` / `sell` (priced
        identically to the TypeScript reference to the lamport across
        several sizes, fees landing exactly where configured, slippage
        refused on both sides), `collect_creator_fee` (permissionless to
        crank, pays only the recorded creator — the DAO path, proven with a
        PDA creator and a stranger cranking).
      - **`migrate` now PROVEN** end to end on the real Raydium binary, both
        mint orderings: a completed curve seeds a real CPMM pool at OUR PDA,
        the LP is burned (supply 0), the migration accounts close, residue
        goes to the protocol, and a second crank is refused. Two blockers
        cleared (commit "launchpad L2: graduation unblocked"):
        (a) "sum of account balances ... do not match" — the raise lived in
        the program-owned BondingCurve account and moved by hand-edited
        lamports. Fixed by the spec'd SYSTEM-owned `["sol-vault", mint]` PDA
        (SPEC-LAUNCHPAD §2.1): buy pays in, sell/migrate pay out, every leg a
        signed `system_program::transfer`; the debit/credit helpers are
        deleted. INV-SOL-CONSERVATION strengthened to assert the raise
        physically sits in the sol vault and the curve account never holds a
        lamport of it.
        (b) Raydium `RequireEqViolated` on `pool_state.is_signer` — the
        raydium-cpmm-cpi crate declares pool_state as a non-signer, so its
        generated CPI can only seed Raydium's canonical pool PDA. We seed OUR
        unsquattable `["cpmm-pool", mint]` PDA (decision A8), which the
        deployed program requires to sign. Fixed by hand-building the
        `initialize` instruction (`initialize_cpmm_pool`) with pool_state +
        creator as signer metas and `invoke_signed`.
      - Two real bugs found and fixed on the way, both only visible by
        running it: (a) the `Migrate` context blew the 4 KB BPF stack, and
        the corrupted frame read `complete` back as false — the fix is
        `Box`ing every deserialized account in the heavy contexts; (b) the
        creator fee vault had to be seeded to the rent floor inside
        `create_coin`, or the first buy of every coin failed on D-009.
      - Harness: tests/helpers/launchpad-harness.ts (hand-rolled
        discriminators, PDAs, instruction builders, byte-offset decoders,
        and `grindMint` for both wSOL sort orders).
      - GOTCHA worth remembering: the bankrun harness only inflates
        `*.so.gz` when no `.so` exists, so a rebuilt program silently runs
        as the stale binary until `tests/fixtures/<name>.so` is deleted.
- [x] **L3 — SDK launchpad module + NativeCurveRail** (packages/sdk/src/launchpad/*
      + rails/native.ts; 11 unit tests). Browser-safe builders/PDAs/state
      decoders/event codec/error map/cluster selection. The bankrun harness now
      DELEGATES to these builders, so the integration suites (11/11 on real
      binaries) are the SDK's own proof — drift is impossible.
- [x] **L4 — backend indexer + REST + SSE + first production entrypoint**
      (packages/backend/src/launchpad/* + server.ts; 76 backend tests). Polling
      indexer behind a TxSource seam, sqlite store, board/coin/trades/candles,
      SSE hub, metadata upload (self-host + optional sharp), allowlisted RPC
      proxy, rate-limited airdrop, exact-origin CORS. All injected/testable.
- [x] **L5 — frontend board + coin page + native launch flow** (app/; 8 new
      unit tests, 31 app total). /board (New/Graduating/Graduated, SSE-live),
      /coin?mint= (progress, trades, buy/sell panel), /create (image→metadata→
      create_coin). The load-bearing piece is `app/lib/tx-sender.ts`: the
      devnet send pipeline (sign-only + broadcast to OUR RPC + landing
      verification) that resolves the wallet-broadcast trap (D-038). Wallets
      widened to all Wallet Standard wallets; security headers + devnet banner +
      disclaimer + equal-prominence nav. DEFERRED polish: dynamic OG images.
- [x] **Launchpad e2e** (app/e2e/{board,coin,create}.spec.ts + harness; 22 e2e
      total). Hermetic same-origin RPC stub with byte-accurate fabricated
      accounts; the buy/create specs run the REAL send pipeline in the browser
      — which caught the web3.js legacy-simulate overload bug (D-040).
- [x] **Devnet deploy + GATE L2 PASS** (2026-08-08, evidence in GATES.md):
      program `DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V` live on devnet,
      config initialized, coin created → bought to completion → migrated to a
      real devnet Raydium CPMM pool with LP burned. Frontend live at
      https://mtremolada.github.io/dao.fun/ (GitHub Pages static export,
      backendless chain-direct mode). Railway backend (global board / live
      feed) awaits the operator's account — RUNBOOK.md § E.
- [~] **Deploy prep docs (D/E/F)** — RUNBOOK.md (program→devnet, Railway,
      Vercel, ops), scripts/launchpad-init-devnet.ts + scripts/gate-l2-devnet.ts,
      Procfile/railway.toml/vercel.json, DECISIONS D-036..D-040, REDTEAM §6.
      Remaining: Railway/Vercel hosted tier (operator account).
- [x] **L6 — keeper graduation crank + creator-fee sweep**
      (packages/keeper/src/graduation.ts; 6 tests). Permissionless, idempotent,
      per-item isolated; inlined into server.ts for the single-service deploy.
- [x] GATE L1 (hermetic) → [x] GATE L2 (devnet, 2026-08-08) → [ ] GATE L3
      (operator go/no-go, mainnet — out of scope)
- [x] **Terminal T1–T3 — /coin is a trading terminal** (2026-08-08). Shared
      candle aggregation in @daofun/sdk (backend store delegates to it);
      chain-direct trade indexer (curve-PDA signatures → inner-ix event
      decode, localStorage cursor); lightweight-charts candles+volume with
      MCap/Price modes and local re-bucketing; stats strip; trades / top
      traders / info tabs; position card (avg cost, unrealized/realized
      PnL); trade-panel presets + live balances.
- [x] **Terminal T4 — post-graduation swaps (D-041)**. SDK Raydium surface:
      packed PoolState/AmmConfig decoders, ceil/floor-exact
      `cpmmSwapBaseInputQuote`, fee-adjusted `cpmmPoolReserves`, hand-built
      13-account `swap_base_input`. Proven by
      tests/launchpad-cpmm-swap.integration.test.ts: graduate → swap with
      minimum_amount_out == quote (exact both directions, both mint
      orderings, fee-adjusted sell leg, +1-lamport refusal) on the deployed
      binary. App: lib/amm-actions.ts wrap→swap→unwrap; trade panel goes AMM
      when migrated (tri-state pool load), stats/position price from pool
      reserves. Suites now: 188 sdk + 76 backend + 25 keeper + 45 app unit,
      39 integration, 22 e2e; eslint+tsc clean.
- [x] **Terminal T5 — terminal e2e + docs + deploy** (2026-08-08). e2e harness
      extended (batched JSON-RPC, getMultipleAccounts, fabricated
      PoolState/AmmConfig/vault bytes, trade-event transactions);
      app/e2e/terminal.spec.ts: a graduated coin swaps on the AMM through the
      REAL send pipeline with the rendered quote equal to SDK math (caught a
      real bug: AMM ATAs must allow off-curve owners — DAO treasuries), and
      the no-backend terminal reconstructs trades/stats/chart/position from
      wire-shaped RPC responses. README/PROGRESS/DECISIONS refreshed. Pages
      deploy is automatic on push to the working branch (workflow already
      targets it). 24 e2e total; all suites green.
- [x] **D-032 decision CLOSED — Guarded commits to Option A (D-042,
      2026-08-08).** Operator-delegated; the verification spike
      (tests/guarded-gate-spike.integration.test.ts, 4 tests on the deployed
      GovER5 v3.1.4 binary) proved front-door exclusivity: u64::MAX community
      create-weight is an explicit disabled sentinel (whale + delegate
      refused), zero-weight council refused, and the gate's sole council
      token authors community-electorate proposals the community votes to
      Succeeded. GATE 2 + GATE L2 sign-off lines recorded under the same
      delegation. Remaining Guarded build (gate create_proposal CPI,
      guarded ceremony mode, SDK/frontend, clearance flow) is Stage 3 WIP.
- [x] **Guarded SHIPPED (D-043, 2026-08-09).** Gate v2: bind_realm /
      create_gated_proposal / insert_gated_transaction (in-flight whitelist
      on the exact inserted bytes) / sign_off_gated_proposal — all CPIs
      client-parity, PDA-signed, proven on the deployed GovER5 binary
      (tests/guarded-gate-v2.integration.test.ts, incl. the PRODUCTION
      buildCreateDaoIxs("guarded") ceremony leg). SDK: gate module (builders
      + PDA mirrors, bankrun-proven), guarded matrix/launch-form/ceremony,
      DEFAULT_GATE_WHITELIST = the full 6.8 menu. App: ONE /launch page,
      four protection cards, Guarded default + zero-config, home reduced to
      a single CTA. Suites: 194 sdk + 76 backend + 25 keeper + 45 app unit,
      47 integration (17 files), 24 e2e; eslint + tsc clean; static export
      builds.
- [x] **One create page + board front page (D-044, 2026-08-09).** `/create`
      is the only creation surface: Simple token | DAO token toggle, DAO
      options revealing inline (protection cards with per-level detail, size
      tier with resolved numbers in human units, advanced overrides).
      The DAO ceremony now creates the coin on OUR curve with creator = the
      Squads vault, so both toggle options share one rail and the DAO flow
      works on devnet. Board became the front page with New / About to
      graduate / Graduated side by side; shared `boardBucket` rule + fixed
      indexer "graduating" filter (was a synonym for "new"). `/launch` and
      `/board` kept as redirect/alias. Suites: 199 sdk + 78 backend + 25
      keeper + 45 app unit, 47 integration, 26 e2e; eslint + tsc clean.
- [x] **Your Profile (D-045, 2026-08-09).** /profile: wallet summary,
      claimable creator fees (one vault across all launches, rent floor
      excluded) with Claim, and Your Launches with terminal links + a
      permissionless "Graduate now" crank for finished curves. Discovery is
      getProgramAccounts(dataSize 143 + creator memcmp) — the size filter
      keeps the 277-byte Config (fee recipient at the same offset) from
      being decoded as a coin. Nav: Board | Create | Profile. 50 app unit +
      28 e2e.
- [x] **G0 — Raydium liquidity locker verified on the deployed binary
      (D-049, 2026-08-09).** Blocking spike for perpetual post-graduation
      fees. `tests/launchpad-lock-verify.integration.test.ts` (8 tests)
      drives `lock_cp_liquidity` + `collect_cp_fees` against the real
      `LockrWmn…` binary in bankrun: discriminators/seeds/account orders
      pinned, recipients proven UNCONSTRAINED (a payout landed in a non-ATA
      account owned by an unrelated PDA), fee-key ownership proven to be the
      sole authority, PDA collection proven via a Squads vault
      `invoke_signed`, `fee_nft_mint` proven to accept a PDA (so `migrate`
      stays single-signer), irreversibility proven at the dispatcher, and
      the bill measured: 23,328,400 lamports + 166,769 CU to lock,
      103,408 CU to collect. Also corrected a false earlier finding — the
      locker DOES have `collect_clmm_fees_and_rewards`; CPMM is chosen on
      its merits, not on CLMM being incapable. Fixture fixed (the first dump
      kept the 45-byte ProgramData header and was not a loadable ELF), dump
      script + `fixture-slots.json` now pin it at slot 362,025,476.
      Suites: 54 integration (18 files); eslint + tsc clean.
- [x] **Fee model shipped end to end (D-050, 2026-08-09).** The coin's own
      protocol fees pay for its graduation, so 100% of the 85.005 SOL raise
      becomes liquidity; the LP is locked with Raydium's Burn & Earn instead
      of burned (config-gated, mainnet-only); and `collect_graduated_fees`
      pays the coin side 100% to the creator while the SOL side repays the
      graduation and then splits 20/80. New per-mint PDAs: protocol-vault,
      fee-authority, fee-nft, graduated. New instructions:
      `set_graduation_config`, `collect_protocol_fee`,
      `lock_graduated_liquidity`, `collect_graduated_fees`. Proven on the
      REAL Raydium CPMM + locker binaries
      (tests/launchpad-graduated-lock.integration.test.ts, 4 tests) with
      real swaps generating real k-growth and the split asserted to the
      lamport. Suites: 61 integration, 199 sdk + 78 backend + 58 app + 25
      keeper unit, 32 e2e; eslint + tsc clean. BLOCKED: devnet deploy needs
      ~3.5 devnet SOL (faucets rate-limit this IP).
- [x] **The fee stream is visible, and the suite is honest again
      (2026-08-09).** The post-graduation crank is wired into the backend's
      keeper loop (both legs are permissionless, so unwired meant "accrues
      only if a human remembers"); the coin page and `/profile` both read the
      `["graduated", mint]` record and say **locked or burned** rather than
      implying a stream that may not exist — `/profile` in ONE
      `getMultipleAccounts` round, because a rate-limited per-coin read would
      have rendered as "burned", the single wrong answer that matters. Both
      branches pinned by e2e (one coin seeded with a record, one without).
      `buildGuardedProposeIxs` closes the last direct-propose path on guarded
      realms. And the integration flake is root-caused (D-051): a
      use-after-free in solana-bankrun corrupts `AddedProgram.name`,
      solana-program-test panics, and the napi promise is never settled — the
      harness now watchdogs every call and retries context creation once, so
      the wedge costs 60s instead of 300 and lands green. Suites: 63
      integration, 199 sdk + 78 backend + 65 app + 25 keeper unit, 33 e2e;
      eslint + tsc clean.
- [x] **Deep pass over the live devnet deployment (D-052, 2026-08-09).**
      Written as `scripts/devnet-audit.ts` rather than a read-through,
      because a read-through checks what I believe the code does. It found
      two defects a green suite could not: five legacy coins had no protocol
      vault, so EVERY buy under ~0.127 SOL failed with "insufficient funds
      for rent" (proved on chain before fixing, fixed by funding the PDAs —
      no program change possible or needed); and `app/lib/cluster.ts` kept
      its own stale copy of the program id, pointing any run without the env
      var at a program that has never been deployed. Both fixed and
      re-verified, with a regression test that the app and SDK share ONE
      constant. Also hardened `collect_graduated_fees` to pin the wSOL mint
      as `migrate` does (it was refused by Raydium's own ConstraintTokenMint
      before — measured 0x7de — which was Raydium enforcing our invariant),
      rebuilt, redeployed devnet (`2W82hMgj…`), and established the full
      chain source → build → fixture → deployed as byte-identical, now
      asserted by the audit. `scripts/devnet-smoke.ts` drives create → buy →
      sell → collect_creator_fee → collect_protocol_fee against the live
      binary, lamports checked against the SDK's quote math. Suites: 63
      integration, 199 sdk + 78 backend + 67 app + 35 keeper unit, 33 e2e.
- [x] **GATE L5 — the guarded front door LIVE on devnet (D-053,
      2026-08-09).** Before spending anything, checked whether devnet is even
      the program we designed against: it is NOT. Same address, but
      spl-governance **3.1.2** vs mainnet's **3.1.4** fork, and Squads differs
      in both binary and ProgramConfig. Dumped both as fixtures, pinned the
      difference, and re-ran the D-042 load-bearing assertions against the
      DEVNET binaries in bankrun — they hold, which is what makes the live run
      meaningful. That parity work also caught a harness bug no test could
      have: the mainnet Squads treasury was pinned for every context, so any
      devnet DAO test would have failed on a config mismatch production never
      had. Then found the gate's `declare_id!` was undeployable (its keypair
      was lost with a `target/` rebuild), adopted the key we hold, saved it to
      `.wallets/`, rebuilt, re-ran the gate suites, and deployed
      (`3RXXk38DTPzD…`). The live run drives the production ceremony: whale
      refused with "Voter weight threshold disabled", anyone authors through
      the gate, community votes. Suites: 66 integration, 199 sdk + 78 backend
      + 67 app + 35 keeper unit, 33 e2e.
- [x] **The board actually shows the launchpad (D-054, 2026-08-09).**
      Operator reported the new devnet coins were not on the front end. The
      serverless board discovered coins from `localStorage` — "mints this
      browser has visited" — so it was full on the developer's machine and
      EMPTY for every real visitor, and no coin created elsewhere could ever
      appear. Discovery now reads the program: one getProgramAccounts for the
      curves (dataSize filter, which keeps the Config account from decoding as
      a coin) plus one batched getMultipleAccounts for metadata, two calls
      total; localStorage is demoted to a hint for a coin created seconds ago.
      Verified against live devnet — 11 of 11 coins found with names — and
      pinned by an e2e with an empty localStorage that fails on the old code.
- [x] **The board's cost no longer grows with the launchpad (D-055,
      2026-08-09).** Operator asked what happens when people start using it.
      Measured: the scan returns ~440 bytes per coin (4.8 KB today, 4.4 MB at
      ten thousand), and the first version fetched metadata for EVERY coin
      before deciding which few dozen to draw. Reordered — scan, bucket and
      rank on curve data, cap each column, then read names only for what will
      be rendered — giving 2 RPC calls whatever the size, asserted at 10 coins
      and at 50,000 in `app/test/board-scale`. The linear scan payload cannot
      be fixed client-side and is documented instead: SCALING.md records the
      measurements, the order things break in (RPC limits, then indexer
      throughput, then SQLite, then ranking semantics), and the cheapest fix
      at each step. The path itself needs no new architecture — the backend
      indexer exists and the app switches to it on NEXT_PUBLIC_API_URL.
- [x] **Live updates — push, not poll (D-056, 2026-08-09).** The board never
      updated and the coin page polled every 5s. Now one `programSubscribe`
      drives the whole board and `accountSubscribe` drives the coin page,
      measured at 511–1,025 ms from send — before the trader's own
      confirmation returns. Cards patch in place and re-bucket; the tape is
      poked by the push rather than waiting for its tick; the price flashes
      green/red with `prefers-reduced-motion` honoured. The status follows the
      SOCKET rather than the fact that subscribe() returned (my first version
      got that wrong, which is the "looks live, is frozen" failure), and a 30s
      reconciliation read runs regardless so a silently dead socket cannot
      freeze the screen. An RPC that refuses the subscription degrades to
      polling and says "delayed". Suites: 82 app unit (13 files), 34 e2e.
- [x] **Everything devnet can finish, finished (D-057, 2026-08-09).**
      `PLAN-DEVNET-FINISH.md` scoped the subset of LAUNCH.md that needs no
      mainnet SOL and no operator decision, and it is done:
      - **GATE L5 closed live.** `devnet-guarded-run.ts --fast` runs the
        production ceremony against a short-window governance and drives it to
        `Completed`: finalize, an execution the hold-up REFUSES, then a real
        execution checked against the DAO treasury's lamports. Shared
        `scripts/lib/gov-advance.ts` so the fast run and the 3-day production
        proposal cannot exercise different code.
      - **L-30 dynamic priority fee** (was BLOCKING): per-written-account
        sampling, p75, floor + ceiling + cache, retry escalation on new
        attempts only, shown in the UI, constant fallback. Found in passing
        that the proxy allowlist omitted `getRecentPrioritizationFees`, which
        would have silently disabled the whole thing behind the API.
      - **L-60 metrics / L-63 caps** (was BLOCKING): `/metrics` with indexer
        lag in slots (absent, never a false zero), SSE clients, event and RPC
        rates, keeper balance; per-client SSE cap beside the global one.
      - **L-42/L-43**: `read-path.ts` — the indexer serves what it can, the
        chain is a fallback, and the fallback is visible.
      - **L-31/L-32**: one commit per frame (keyed, so it is bounded in a
        hidden tab), reconnect with backoff + full jitter, and resync on every
        connect rather than a replay window that can still have gaps.
      - **L-91 / L-26 / L-13 / L-33 / L-36**: concurrent indexer fetch with
        ordering preserved, `--cluster` on the audit with the mainnet
        expectations INVERTED (LP non-zero, fee record present), an in-product
        statement of what a user is trusting, hidden-tab scan suppression, and
        board skeletons.
      Not devnet-closable, and stated as such: L-01..L-07 (operator
      decisions), L-10..L-12 (mainnet keys), L-20..L-25 (mainnet SOL),
      L-40/L-41/L-46 (provisioning), **L-50..L-52 GATE L4** (the locker does
      not exist on devnet), L-61 (alerts need a destination), L-92
      (threshold-gated).
