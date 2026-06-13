# CLAUDE.md — session memory for the PumpFun DAO Launchpad

Spec-driven build per **SPEC.md** (v2.0 — the only authoritative spec).
Doctrine: tests BEFORE code on anything touching funds/PDAs/governance;
verify against the deployed binary before trusting any interface; record
everything in **DECISIONS.md** (D-001..D-033 so far); gate evidence in
**GATES.md**; running checklist in **PROGRESS.md**; pins in
**VERSIONS.md**; capture analysis in **REDTEAM.md**.

## ⚠ LIVE + the one PENDING operator action (read first)

The dapp is **LIVE on GitHub Pages** (`https://mtremolada.github.io/dao.fun/`,
deploy-pages triggers on `claude/zen-cori-t9td4x`). Council/Cypherpunk/Sovereign
do the whole loop client-side on mainnet (launch → in-browser INV-9 verify +
decode + verifyDao → deposit/vote → permissionless execute → collect fees),
all on audited deployed programs. The app launch now delegates to the
real-binary-tested `buildLaunchPlan` (D-035) — settings flow verified.

**PENDING (needs the operator's wallet):** deploy `proposal-gate` to mainnet to
turn Guarded on. Turnkey: `programs/proposal-gate/DEPLOY.md` +
`scripts/deploy-gate.sh`. Needs a funded deployer (~3 SOL) + an upgrade-authority
decision; the program is UNAUDITED (deliberate GATE 3 override — operator's
call). Until then Guarded stays unselectable via `NEXT_PUBLIC_GUARDED_ENABLED`
(unset) — turning it on without the program live would brick the DAO at
gate-init. The code/UI/validation are 100% ready; it's a one-variable flip
once deployed.

## RESOLVED earlier: Guarded mode = Option A, SHIPPED (D-033)

The D-032 operator decision came back **"implement A end to end"** —
done in session of 2026-06-12 (branch
`claude/option-a-exploration-p6iybh`). The gate is now the realm's
FRONT DOOR on guarded realms:

- Creation exclusivity VERIFIED on the deployed GovER5 binary first
  (spike: u64::MAX community threshold refuses a full-supply
  depositor + delegate; council TOR authors community-voted proposals;
  gate seat H+1 vs minCouncil H+1 beats any human pooling; veto
  percent adjusted for the 2H+1 supply; realm authority parks on a
  non-signing PDA).
- proposal-gate v2: guard_create_proposal / guard_insert_transaction
  (validation engine on the EXACT forwarded bytes; governance-program
  legs hard-refused while guarded) / guard_sign_off / guard_cancel /
  deposit_council / release_realm_authority. CPI layouts pinned from
  the 0.3.28 client (binary-proven by GATE 1) and re-proven by use.
- SDK: gate.ts builders + guardedVetoPercent (strict-both-sides
  property-tested), buildCreateDaoIxs guarded ceremony (new gateSetup
  group; realm authority -> gate PDA SetUnchecked), matrix guarded =
  tier floor + veto required; backend launch step sends gateSetup.
- Voted exit proven: ratchet -> release_realm_authority -> arbitrary
  inserts -> voted config restore -> direct creation again (MVP shape).
- Known v1 limits (all in D-033): setParam unavailable while guarded;
  realm-wide outstanding-proposal cap via the single gate seat;
  buffered Squads chains refused; launch form keeps guarded
  UNSELECTABLE until GATE 3 (external audit + devnet deploy) — that is
  spec, not an oversight.

Still pending from the operator: the **GATE 2 sign-off line** in
GATES.md (all technical legs determined 2026-06-12). GATE 3 work
remaining: launch-coordinator, per-instruction byte/floor menu
validation, external audit + bounty.

## Where the build stands

- **CONSOLIDATED + LIVE (D-034, 2026-06-13).** The three sibling branches
  are merged onto `claude/zen-cori-t9td4x` (the current session branch;
  push ONLY here; no PRs unless asked) and deployed to GitHub Pages at
  `https://mtremolada.github.io/dao.fun/` (deploy-pages.yml now triggers
  on this branch too). The static Phantom dapp does the whole loop
  client-side: launch (Council/Cypherpunk/Sovereign) → verify (in-browser
  INV-9 recompute + decode + verifyDao) → deposit/vote → permissionless
  execute → permissionless collect-fees. Reads ride the user's RPC.
  Guarded code is integrated + real-binary-tested but stays UNSELECTABLE
  and the gate program is NOT on mainnet (unaudited — GATE 3).
- Prior branches (now subsumed): MVP static pivot on
  `claude/spec-driven-repo-reset-yqzenh`; Option A on
  `claude/option-a-exploration-p6iybh`; decentralized read/verify +
  audit passes on `claude/audit-execution-oaj5aa`.
- Suites: 242 unit (sdk 145 / keeper 19 / backend 62 / app 16) + 23
  root integration (real mainnet binaries in bankrun, hermetic — incl.
  stage3-guarded end-to-end + the exclusivity spike) + 12 Playwright
  e2e; eslint clean; **tsc clean repo-wide** (operator: "the bar is no
  errors" — pre-existing action-amm literal-type errors fixed).
- Stage 0 + Stage 1 DONE and operator-signed (GATES.md). Action menu
  6.8 COMPLETE. Holder-snapshot service (D-026), browser signing via
  wallet-standard + server-built txs (D-028).
- Stage 3: build pipeline (D-029), proposal-gate v1 validation engine +
  ratchet (D-030), fork findings (D-031/D-032), Option A front door
  (D-033). Gate fixture rebuilt: tests/fixtures/proposal_gate.so.gz;
  rebuild cmd in the stage3-guarded test header.

## Operational gotchas that bit previous sessions

- Toolchain for programs/: Anza solana-cli 4.0.1 installer + curl-fetch
  platform-tools v1.53 into `~/.cache/solana/v1.53/platform-tools/`
  (the proxy CA breaks cargo-build-sbf's downloader, D-029). Add
  `~/.local/share/solana/install/active_release/bin` to PATH.
- Workspace packages resolve through `dist/` — run
  `pnpm --filter @daofun/sdk build` (and backend) before integration/e2e
  pick up source changes; the e2e stub server reuses stale servers
  unless killed.
- `programs/target/` is gitignored: cargo-build-sbf drops a PRIVATE
  program-id keypair there. Program fixtures are committed gzipped
  (`tests/fixtures/*.so.gz`) so CI needs no Rust toolchain.
- The full parallel `pnpm test` can flake a heavy bankrun suite into a
  300s timeout (seen once on action-buyback); re-run the file alone
  before suspecting a real break.
- Public RPC from this datacenter IP: token-program gPA is
  index-excluded (-32010) AND per-method rate-limited — use Helius/keyed
  RPC for live holder snapshots (D-026).
- bankrun dedups byte-identical txs — disambiguate with a varying
  CU-limit instruction (gate proposals differ by random seed already).
- Standing constraints: never commit/log private keys; mainnet keys are
  disposable gas-only (D-008); keep 0.01725 SOL in deployer
  `FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds` (operator: frontend
  testing); commit messages end with the session URL footer.
