# Test infrastructure map — dao.fun (for tests-first bonding-curve program work)

## 1. How bankrun integration tests load real mainnet binaries

**Single shared harness: `/home/user/dao.fun/tests/helpers/bankrun-harness.ts`** (the only file in tests/helpers/).

Fixture loading mechanism (lines 78–90):
- `const FIXTURES = resolve(__dirname, "..", "fixtures")` then **`process.env.SBF_OUT_DIR = FIXTURES`** — solana-bankrun's `start()` resolves `{ name: "spl_governance", programId }` entries to `${SBF_OUT_DIR}/${name}.so`.
- Fixtures are committed **gzipped** (`tests/fixtures/*.so.gz`, ~10x compression of zero-padded programdata); on import the harness inflates any `.so.gz` lacking a sibling `.so` via `gunzipSync` and writes the `.so` next to it. CI therefore needs no Rust toolchain and no network.
- Fixtures present: `spl_governance`, `squads_v4`, `vsr`, `token_2022`, `pump`, `pump_fees`, `pump_amm`, `merkle_distributor`, and the repo's **own built program `proposal_gate.so.gz`** — plus two live-state JSON dumps: `squads-program-config.json` (single account) and `pump-accounts.json` (array of config/global PDAs).

Registration at addresses:
- **`startCtx(extraPrograms?: AddedProgram[], extraAccounts?: AddedAccount[])`** — calls bankrun `start()` with spl_governance + squads_v4 always loaded (program IDs from `packages/sdk/src/constants`), plus the Squads ProgramConfig account injected from `squads-program-config.json` (`{address, info:{lamports, data: base64, owner, executable:false}}`).
- **`startPumpCtx()`** — layers pump, pump_fees, pump_amm, token_2022 on top and injects every account from `pump-accounts.json` the same way. This is the template for loading a program **plus its live config-state accounts**.
- A test adds its own program with `startCtx([{ name: "proposal_gate", programId: GATE_PROGRAM_ID }])` — name maps to the fixture file, programId places it at the address.

Fixture provenance: `/home/user/dao.fun/scripts/dump-mainnet-programs.ts` (`npx tsx scripts/dump-mainnet-programs.ts`, idempotent, `--force` to redump). It strips the 45-byte BPF upgradeable-loader ProgramData header and gzips level 9 into `tests/fixtures/<name>.so.gz`; also dumps the state accounts.

**Rebuild command for own-program fixtures** — the convention CLAUDE.md calls "rebuild command in the test header" was in the (now-deleted, replaced by stage3-gate) `tests/stage3-build.integration.test.ts` header, recoverable via `git show 1c50285:tests/stage3-build.integration.test.ts`:
```
cargo build-sbf --manifest-path programs/proposal-gate/Cargo.toml
gzip -c programs/target/deploy/proposal_gate.so > tests/fixtures/proposal_gate.so.gz
```
(D-029 pins the toolchain: solana-cli 4.0.1 / cargo-build-sbf 4.0.0 / platform-tools v1.53 / anchor-lang 0.30.1; platform-tools must be curl-fetched into `~/.cache/solana/v1.53/platform-tools/` because the proxy CA breaks the built-in downloader. `programs/target/` is gitignored — it holds a PRIVATE program-id keypair.)

**CU-limit disambiguation trick** — `/home/user/dao.fun/tests/gate1-matrix.integration.test.ts` lines 230–246: bankrun's blockhash often stands still, so byte-identical txs are rejected as "already processed". Pattern: keep a nonce and prepend `ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + nonce++ })` to make each tx unique (`readWeight()` helper in the VSR leg).

## 2. Every helper in tests/helpers/bankrun-harness.ts

Constants: `PROGRAM_VERSION=3`, `SUPPLY=200_000_000_000n`, `BASE_VOTING_TIME_S=3*86400`, `MICRO_HOLDUP_S=72*3600`, `VAULT_FUND=890_880`, `TREASURY_PREFUND=6_000_000` (D-016 Squads execution rent), `TEST_TIMEOUT=300_000`, `squadsConfig` (parsed fixture JSON).

Transaction plumbing:
- `send(ctx, ixs, signers, feePayer?)` — legacy tx, ctx.payer default fee payer, dedups payer from signers.
- `sendWithAlt(ctx, ixs, payer)` — v0 tx with a throwaway address lookup table (for account-heavy inserts/executes that exceed legacy size). Gotchas encoded: `recentSlot` must be `getSlot() - 1n`; ALT activates only after `ctx.warpToSlot(slot + 1n)`; signers stay static.
- `sendMeasured(ctx, ixs, signers, feePayer?)` → `bigint` CU consumed (via `tryProcessTransaction` → `meta.computeUnitsConsumed`); throws with program logs on failure. Basis of the CU-budget suite.
- `sendExpectFail(ctx, ixs, signers)` → returns `error + logMessages` joined string for `.toMatch(/…/)` assertions; throws if the tx unexpectedly succeeds.
- `prefundMissingWritables(ctx, ixs)` — D-009: transfers 890,880 lamports to every missing writable non-signer account (rent-floor rule for fee-crumb recipients).

State/clock:
- `warpSeconds(ctx, seconds)` — rebuilds `Clock` with shifted unixTimestamp via `ctx.setClock` (hold-up/lockup-decay assertions).
- `balance(ctx, addr)`, `mintRent(ctx)`.
- `readGov(ctx, addr, Type)` — deserializes any spl-governance account via `GovernanceAccountParser`.

DAO/governance/Squads setup (airdrops + token minting are inline here, not separate helpers):
- `createDao(ctx, mode)` → `Dao {mint, realm, governance, nativeTreasury, multisigPda, vaultPda, params, voter, voterTor, councilMint, councilMember, councilTor}`. Does everything: SOL transfers to voter/council member (1 SOL each — "airdrop" is a SystemProgram.transfer from ctx.payer), creates classic SPL mint (6 decimals), mints full SUPPLY to voter ATA, nulls mint authority (INV-5), resolves `resolveGovernanceParams({mode, tier:"micro"})`, creates the Squads treasury FIRST against the advance-derived native treasury (`buildCreateTreasuryIx` + `deriveGovernanceChainFromMint`), asserts rentCollector == native treasury, then `buildCreateDaoIxs` executed in contract order (council mint → realmSetup → governanceSetup), deposits governing tokens (`withDepositGoverningTokens`), sets up the council member deposit for council mode, and prefunds vault (VAULT_FUND) + treasury (TREASURY_PREFUND). Uses the SAME production sdk builders the launch flow uses — that's the doctrine.
- Proposal lifecycle: `proposeSweep(ctx, dao, index)` and `proposeInner(ctx, dao, index, innerIxs, label, directIxs?)` → `MadeProposal {proposal, wrapped, ptAddrs, innerHash, recipient}` — drives production `buildProposeIxs` (create → inserts, falling back to `sendWithAlt` on "too large" → signOff), collects ProposalTransaction addresses, asserts descriptionLink == artifact hash (D-017).
- Voting/finalize/execute: `castCommunityYes`, `castCouncilVeto` (council mint is the vetoing mint, D-011), `finalizeAfterVotingWindow` (warps past BASE_VOTING_TIME_S then `withFinalizeVote`, returns ProposalState), `executeIxsFor(dao, made, i)`, `executeAll` (prepends 400k CU limit; ALT fallback), `chainHashOf(ctx, made)` — re-reads ProposalTransactions from chain and hashes for INV-9 equality.

## 3. Property / fuzz / CU suites (GATE 2 legs)

- **Property**: `/home/user/dao.fun/packages/sdk/test/property-capture.test.ts` — **fast-check 4.5.3** (pinned in packages/sdk/package.json devDeps). Pattern: model IS the real code (`resolveGovernanceParams`, `TIER_FLOORS`, `holdUpFloorSeconds` from `src/matrix`), plus the on-chain-verified VSR weight formula reimplemented as closed-form bigint math. Arbitraries: `fc.constantFrom(modes/tiers)`, `fc.bigInt({min,max:U64_MAX})`, `fc.integer` for windows; `{ numRuns: 200–500 }`. Properties: unlocked weight == 0; Beanstalk impossibility (positive time-to-drain); the hit-and-run dichotomy (locked-through-drain OR ≥ sat×quorum% public notice); a numbers-pinning non-random test; sovereign hold-up-0 requires explicit double-confirm.
- **Fuzz**: `/home/user/dao.fun/packages/sdk/test/fuzz-bounds.test.ts` — fast-check at u64 bounds. Patterns worth copying for a bonding curve: pre-generated keypair POOL (Keypair.generate inside fc loops is slow); `fc.bigInt({min:0n,max:U64_MAX})` amounts with exact-equality assertions ("no tolerance windows on money math"); books-close invariants (allocated + dust == total); merkle proof soundness + tamper rejection; canonical-root order-independence; wrap/unwrap roundtrip. This suite found a real bug (D-027 privilege-normalization hash mismatch).
- **CU budget**: `/home/user/dao.fun/tests/cu-budget.integration.test.ts` — real binaries in bankrun; `CU_LIMIT=400_000n`, `CEILING = limit*85/100` (spec Section 8: fail within 15% of limit); `executeAllMeasured()` wraps harness `sendMeasured` and asserts per-executed-tx with the consumed number embedded in the assertion message so GATES.md can quote real margins.

## 4. Configs and unit/integration split

- Root `/home/user/dao.fun/vitest.config.ts`: `include: ["tests/**/*.test.ts"]`, testTimeout 30s, plus a resolve alias pinning `@pump-fun/pump-sdk` to its CJS entry (broken ESM, D-002). Package configs: `packages/sdk/vitest.config.ts` (same alias, `test/**/*.test.ts`, 60s), backend + keeper (30s), `app/vitest.config.ts`.
- Split is by **filename convention `*.integration.test.ts` + root scripts** (root package.json): `test` = `vitest run && pnpm -r run test`; `test:unit` = `vitest run --exclude 'tests/**/*.integration.test.ts' && pnpm -r run test:unit`; `test:integration` = `vitest run tests --testTimeout=300000`. Integration tests also pass `TEST_TIMEOUT` (300s) per-`it` as a belt.
- CI `/home/user/dao.fun/.github/workflows/ci.yml`: two jobs, both Node 22 + pnpm frozen-lockfile — `unit` (pnpm -r build then `pnpm test:unit`) and `integration` (`pnpm test:integration`), hermetic (fixtures committed, no validator, no network).
- ESLint `/home/user/dao.fun/eslint.config.mjs`: flat config, @typescript-eslint parser+plugin, rules: no-unused-vars (underscore-ignored), eqeqeq smart, no-console off.
- E2E: `/home/user/dao.fun/app/e2e/{dashboard,launch,proposal,wallet}.spec.ts` via `playwright test` (`app/playwright.config.ts`); gotcha: workspace packages resolve through `dist/` — rebuild sdk/backend first, kill stale stub servers.

## 5. GATES.md / REDTEAM.md formats

- **GATES.md**: per-gate section with Status line (PASS/DETERMINED + date), a table or bullet list of concrete on-chain values (mints, PDAs, tx signatures), an explicit "**Accept criterion** / **Result**" pair with real numbers (e.g. `890880 -> 7271603`), pointer to machine evidence JSON in `/home/user/dao.fun/.gate-evidence/*.json`, cross-references to DECISIONS.md D-numbers, exact test file + run command (`pnpm test:integration`) for hermetic legs, quoted measured numbers (CU margins), and a trailing `Operator sign-off:` line (GATE 2's is still blank).
- **REDTEAM.md**: numbered attack taxonomy; each attack gets a **Verdict** line and a disposition of exactly one of: (a) reproduced against real binaries and refused (cites the test file), (b) excluded by a machine-checked property (cites the property test), (c) residual risk with blast radius + mitigation. Rule stated in the header: "Nothing here is prose-only: each verdict cites the test or decision record that pins it."

## 6. The proposal-gate own-binary pattern (what the bonding-curve program should copy)

`/home/user/dao.fun/tests/stage3-gate.integration.test.ts` — the exact reuse template:
1. Build fixture with cargo build-sbf, gzip into `tests/fixtures/<name>.so.gz` (commands above); commit the .gz only.
2. Hardcode the program ID from `declare_id!` (`3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg` for the gate) and load with `startCtx([{ name: "proposal_gate", programId: GATE_PROGRAM_ID }])` — own program runs ALONGSIDE the real deployed binaries, driven by the production sdk builders (createDao/proposeInner).
3. No anchor TS client: manual instruction building — `disc(name)` = `sha256("global:"+name)[0..8]` for ix discriminators (`sha256("account:"+Name)` for account discs, per the deleted stage3-build test), `PublicKey.findProgramAddressSync` for PDAs (`gatePda`, `clearancePda`), borsh-by-hand data (`Buffer.concat([disc, ...fields])`, u32 LE vec length prefix), raw `TransactionInstruction` with explicit keys.
4. State assertions by raw byte offsets into account data (`gateMode()` reads byte 72 past disc+realm+governance).
5. Negative paths via `sendExpectFail(...)` matched against program error strings (`/outside the gate whitelist/i`, `/already in use|custom program error/i`, `/one-way toward decentralization/i`).
6. Full-lifecycle proof: propose → vote → finalize → warp hold-up → execute the program's own ix as a governance direct leg (governance PDA as invoke_signed signer), including the same-proposal forward-succeeds/reverse-fails ratchet pattern.

Rust side: `/home/user/dao.fun/programs/Cargo.toml` (workspace, `overflow-checks=true`, lto fat, codegen-units 1 — the 6.9 safety baseline applies to every member; a new bonding-curve crate joins `members`), `/home/user/dao.fun/programs/proposal-gate/Cargo.toml` (anchor-lang 0.30.1 only dependency, cdylib+lib, no-entrypoint/cpi features), `src/lib.rs` (anchor 0.30, hardcoded trusted program IDs as `Pubkey::new_from_array` because anchor 0.30 lacks the `pubkey!` re-export).

## KEY FILES
- /home/user/dao.fun/tests/helpers/bankrun-harness.ts — The one shared harness: SBF_OUT_DIR fixture loading, .so.gz inflation, startCtx/startPumpCtx registration, send/sendWithAlt/sendMeasured/sendExpectFail/prefundMissingWritables, warpSeconds, readGov, createDao, proposeInner/proposeSweep, vote/finalize/execute helpers, chainHashOf
- /home/user/dao.fun/tests/stage3-gate.integration.test.ts — The exact own-built-binary-in-bankrun pattern the new bonding-curve program should reuse: manual anchor discriminators, PDA derivation, raw byte-offset state asserts, sendExpectFail negative paths, governance-executed ix lifecycle
- /home/user/dao.fun/tests/fixtures/ — Committed gzipped program binaries (spl_governance, squads_v4, vsr, token_2022, pump stack, merkle_distributor, proposal_gate) + live-state dumps pump-accounts.json and squads-program-config.json
- /home/user/dao.fun/scripts/dump-mainnet-programs.ts — Dumps mainnet program binaries (strips 45-byte ProgramData header, gzip -9) and state accounts into tests/fixtures; npx tsx scripts/dump-mainnet-programs.ts
- /home/user/dao.fun/packages/sdk/test/property-capture.test.ts — GATE 2 property suite: fast-check 4.5.3 over the real resolveGovernanceParams + VSR weight formula (capture dichotomy, Beanstalk impossibility)
- /home/user/dao.fun/packages/sdk/test/fuzz-bounds.test.ts — GATE 2 fuzz suite: u64-bound money math with exact assertions, merkle proof soundness, wrap/unwrap roundtrip; pre-generated keypair pool pattern
- /home/user/dao.fun/tests/cu-budget.integration.test.ts — GATE 2 CU suite: sendMeasured against real binaries, 400k limit, fail within 15% (85% ceiling), margins printed into assertion messages for GATES.md
- /home/user/dao.fun/tests/gate1-matrix.integration.test.ts — Mode-matrix suite; lines 230-246 contain the CU-limit nonce trick for bankrun byte-identical tx dedup
- /home/user/dao.fun/vitest.config.ts — Root vitest: include tests/**/*.test.ts, 30s timeout, @pump-fun/pump-sdk CJS alias (D-002); unit/integration split lives in root package.json scripts
- /home/user/dao.fun/package.json — test:unit excludes tests/**/*.integration.test.ts; test:integration runs tests/ with 300s timeout; lint/format
- /home/user/dao.fun/.github/workflows/ci.yml — Two hermetic jobs (unit: build + pnpm test:unit; integration: pnpm test:integration), Node 22 + pnpm, no Rust toolchain needed
- /home/user/dao.fun/eslint.config.mjs — Flat ESLint config: @typescript-eslint, no-unused-vars with _-prefix escape, eqeqeq smart
- /home/user/dao.fun/GATES.md — Gate evidence format: status + on-chain values table + Accept criterion/Result with real numbers + .gate-evidence JSON pointer + operator sign-off line
- /home/user/dao.fun/REDTEAM.md — Red-team format: per-attack Verdict, each one either reproduced-and-refused (test cited), machine-checked property, or residual risk with mitigation; nothing prose-only
- /home/user/dao.fun/programs/Cargo.toml — Rust workspace a new bonding-curve crate joins: overflow-checks=true, lto=fat, codegen-units=1 (spec 6.9 safety baseline)
- /home/user/dao.fun/programs/proposal-gate/src/lib.rs — Reference anchor-0.30.1 program: declare_id, hardcoded trusted program IDs via Pubkey::new_from_array, manual bounds-checked deserialization doctrine
- /home/user/dao.fun/packages/sdk/src/constants.ts — Pinned program IDs (PUMP_, PUMP_AMM_, PUMP_FEES_, SPL_GOVERNANCE_, SQUADS_V4_, VSR_, MERKLE_DISTRIBUTOR_) used by harness and dump script

## REUSABLE
- startCtx / startPumpCtx bankrun bootstrap @ /home/user/dao.fun/tests/helpers/bankrun-harness.ts (lines 109-164) — New program loads as startCtx([{ name: "<fixture-basename>", programId }], extraStateAccounts). startPumpCtx shows how to inject live pump config PDAs — a bonding-curve program interacting with pump reuses it directly.
- sendMeasured / sendExpectFail / prefundMissingWritables / warpSeconds / sendWithAlt @ /home/user/dao.fun/tests/helpers/bankrun-harness.ts — sendExpectFail returns error+logs string for regex asserts; sendMeasured returns CU consumed (bigint) for budget tests; prefundMissingWritables implements the D-009 rent-floor rule fee-paying trades need.
- createDao + proposeInner + castCommunityYes + finalizeAfterVotingWindow + executeAll lifecycle @ /home/user/dao.fun/tests/helpers/bankrun-harness.ts — If the bonding-curve program's ixs must be governance-executed, this is the complete voted-execution rig on the real binaries.
- Own-binary fixture convention + rebuild commands @ git show 1c50285:tests/stage3-build.integration.test.ts (header); convention live in tests/stage3-gate.integration.test.ts — cargo build-sbf --manifest-path programs/<crate>/Cargo.toml; gzip -c programs/target/deploy/<name>.so > tests/fixtures/<name>.so.gz. Put these commands in the new test's header comment — that is the repo convention (CLAUDE.md).
- Manual anchor client helpers: disc(), PDA derivation, raw ix building, byte-offset state reads @ /home/user/dao.fun/tests/stage3-gate.integration.test.ts (lines 52-132) — sha256("global:<ix>")[0..8] and sha256("account:<Account>")[0..8]; no IDL/anchor TS client anywhere in tests.
- CU-limit nonce disambiguation for bankrun tx dedup @ /home/user/dao.fun/tests/gate1-matrix.integration.test.ts lines 230-246 — Prepend setComputeUnitLimit({units: 200_000 + nonce++}) when re-sending otherwise byte-identical txs (bankrun blockhash stalls).
- fast-check patterns for money math @ /home/user/dao.fun/packages/sdk/test/fuzz-bounds.test.ts and property-capture.test.ts — fc.bigInt to U64_MAX, pre-generated keypair POOL, exact-equality (no tolerance) invariants, books-close checks, numRuns 150-500, plus one non-random numbers-pinning test. Directly applicable to bonding-curve price/reserve invariants.
- CU ceiling assertion pattern @ /home/user/dao.fun/tests/cu-budget.integration.test.ts (executeAllMeasured, lines 52-78) — 85% of the production CU limit as ceiling; consumed CU quoted inside the assertion message so GATES.md evidence can copy real numbers.
- Rust workspace + anchor 0.30.1 crate template @ /home/user/dao.fun/programs/ (Cargo.toml workspace + proposal-gate/) — New crate joins members=[]; inherits overflow-checks. cdylib+lib, no-entrypoint/no-idl/cpi features, anchor-lang 0.30.1 as sole dependency.

## GOTCHAS
- programs/target/ is gitignored because cargo build-sbf drops a PRIVATE program-id keypair in target/deploy — never commit it; only the gzipped .so goes into tests/fixtures/.
- cargo-build-sbf's built-in platform-tools downloader fails on the egress proxy CA — curl-fetch platform-tools-linux-x86_64.tar.bz2 into ~/.cache/solana/v1.53/platform-tools/ first (D-029).
- bankrun rejects byte-identical transactions as 'already processed' (blockhash often stalls) — disambiguate with a varying setComputeUnitLimit nonce instruction.
- solana-bankrun loads fixtures via SBF_OUT_DIR; the harness sets it at import time and inflates .so.gz → .so lazily — a new fixture just needs the .so.gz committed and a {name, programId} entry.
- Do NOT build spl-governance instructions from public-master enum indices: the deployed GovER5 binary is a diverged fork with no required-signatory mechanism (D-031/D-032); verify against the deployed binary in bankrun.
- Rent floors (D-009): any account receiving fee crumbs must be prefunded to 890,880 lamports or the runtime rejects the tx — use prefundMissingWritables.
- For sendWithAlt: recentSlot must be getSlot()-1 (current slot is never in SlotHashes), and the lookup table only activates after warping one slot forward; signers and program ids must stay static in v0 messages.
- Account-heavy inserts/executes exceed legacy tx size — catch /too large/ and retry via sendWithAlt (the harness's proposeInner/executeAll already do).
- Stacked governance→Squads→inner executes need a 400k CU limit (200k default is insufficient).
- Workspace packages resolve through dist/ — run pnpm --filter @daofun/sdk build (and backend) before integration/e2e tests pick up source changes; e2e stub servers go stale unless killed.
- Unit vs integration split is purely the *.integration.test.ts filename convention plus root package.json script excludes — name new bankrun tests accordingly or they will run (and time out) in the 30s unit lane.
- The tests-first doctrine for anything touching funds/PDAs/governance is a standing CLAUDE.md constraint; gate evidence must cite exact tests and real measured numbers (GATES.md format), and red-team verdicts must cite a test or decision record, never prose alone.
- tests/stage3-build.integration.test.ts (which carried the canonical rebuild-command header) was deleted when stage3-gate.integration.test.ts superseded it — recover the header via git show 1c50285:tests/stage3-build.integration.test.ts.
- The pump-sdk ESM build is broken — every vitest config that touches it needs the CJS resolve alias (D-002); copy it into any new package's vitest.config.ts that imports @pump-fun/pump-sdk.
