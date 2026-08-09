# CLAUDE.md — session memory for the PumpFun DAO Launchpad

Spec-driven build per **SPEC.md** (v2.0 — the only authoritative spec).
Doctrine: tests BEFORE code on anything touching funds/PDAs/governance;
verify against the deployed binary before trusting any interface; record
everything in **DECISIONS.md** (D-001..D-042 so far); gate evidence in
**GATES.md**; running checklist in **PROGRESS.md**; pins in
**VERSIONS.md**; capture analysis in **REDTEAM.md**.

## ▶ NEXT: perpetual post-graduation fees — PLAN-GRADUATED-FEES.md

Research done against the DEPLOYED binaries (lock program dumped to
tests/fixtures/raydium_lock.so.gz). Finding that decides the design:
Raydium's locker has lock_cp_liquidity, lock_clmm_position and
collect_cp_fees — there is NO collect_clmm_fees, so only the CPMM path
supports "permanent liquidity + claimable fees". It also hard-codes the
MAINNET cpmm/clmm ids and is absent from devnet, so the lock path can
NEVER be exercised on devnet — bankrun-with-mainnet-binaries is the
primary proof, devnet covers everything around it, mainnet canary is the
only live run. Phases G0..G4 in the plan; G0 (spike) is blocking.

## ✅ Guarded SHIPPED (2026-08-09, D-043) — unified launch page live

Gate v2 (four PDA-signed CPIs, client-parity, proven on the deployed
binary incl. the production buildCreateDaoIxs("guarded") ceremony), SDK
gate module + guarded ceremony/form/matrix with the full 6.8 menu as
DEFAULT_GATE_WHITELIST, ONE /launch page (Guarded default, zero-config).
Remaining from PLAN-UNIFIED-LAUNCH: app-side GATED PROPOSE routing for
the action menu on guarded DAOs (dashboard/proposal screens still build
direct proposals — they must route via the gate builders for guarded
realms), a devnet gate deploy if live evidence is wanted, and REDTEAM
guarded row. The DAO launch flow itself remains mainnet/pump-rail.

## ✅ RESOLVED (2026-08-08): Guarded mode enforcement — Option A committed (D-042)

The D-032 pending decision is CLOSED. The operator delegated it
("make the decisions and finish the job"); the recorded recommendation
was executed: the Option A spike ran against the deployed GovER5 v3.1.4
binary and PASSED on every leg
(tests/guarded-gate-spike.integration.test.ts):

- `min_community_weight_to_create_proposal = u64::MAX` is an EXPLICIT
  disabled sentinel on this fork ("Voter weight threshold disabled",
  0x25d) — a full-supply whale AND their delegate are refused;
- a zero-weight council record cannot author (weight, not identity);
- the gate's SOLE council token (supply 1, mint authority null) authors
  proposals whose electorate is the COMMUNITY mint, and the community
  votes them to Succeeded — creation gated, voting untouched.

**Committed design:** ceremony mints the one council token to the gate
PDA's record + writes the guarded config; the gate's create_proposal CPI
runs the D-030 validation engine first. Option B rejected (unneeded),
C not taken. Still to build (Stage 3 WIP): the gate program's
create_proposal CPI instruction, "guarded" mode in buildCreateDaoIxs,
SDK/frontend, clearance flow. MVP scope unchanged (Council + Cypherpunk
first). GATE 2 and GATE L2 sign-off lines are filled (same delegation).

## Where the build stands (end of session …sbqvy)

- Branch: `claude/spec-driven-repo-reset-yqzenh` (push ONLY here; no PRs
  unless asked). Suites: 234 unit + 21 integration (real mainnet
  binaries in bankrun, hermetic) + 12 Playwright e2e; eslint+tsc clean.
- Stage 0 + Stage 1: DONE and operator-signed (GATES.md). GATE 2
  technical legs determined (property/fuzz/CU suites, observability,
  REDTEAM.md, audit dispositions).
- Action menu 6.8 COMPLETE (grant, burn, buyback curve+AMM,
  provideLiquidity, distribute on the immutable Jito merkle distributor,
  setParam). Holder-snapshot service (D-026), browser signing via
  wallet-standard + server-built txs (D-028).
- Stage 3 started: build pipeline proven (D-029 — cargo-build-sbf
  4.0.0 / platform-tools v1.53 / anchor-lang 0.30.1; platform-tools must
  be curl-fetched into ~/.cache/solana/v1.53/ because the proxy CA
  breaks the built-in downloader). proposal-gate v1 SHIPPED (D-030):
  on-chain validation engine (parses real ProposalTransactionV2,
  unwraps the Squads message, whitelist-enforces outer+inner programs)
  + structural one-way INV-11 ratchet. Both proven on real binaries.

## Operational gotchas that bit this session

- Workspace packages resolve through `dist/` — run
  `pnpm --filter @daofun/sdk build` (and backend) before integration/e2e
  pick up source changes; the e2e stub server reuses stale servers
  unless killed.
- `programs/target/` is gitignored: cargo-build-sbf drops a PRIVATE
  program-id keypair there. Our program fixtures are committed gzipped
  (`tests/fixtures/*.so.gz`) so CI needs no Rust toolchain; rebuild
  command in each test header.
- Public RPC from this datacenter IP: token-program gPA is
  index-excluded (-32010) AND per-method rate-limited (10/10 retries
  failed) — use Helius/keyed RPC for live holder snapshots (D-026).
- bankrun dedups byte-identical txs — disambiguate with a varying
  CU-limit instruction.
- Standing constraints: never commit/log private keys; mainnet keys are
  disposable gas-only (D-008); keep 0.01725 SOL in deployer
  `FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds` (operator: frontend
  testing); commit messages end with the session URL footer.
