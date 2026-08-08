# On-chain + SDK layer map (dao.fun) — for adding a new Anchor bonding-curve launchpad program

## 1. programs/proposal-gate (the only existing on-chain program)

**Framework**: Anchor **0.30.1** (`anchor-lang = "0.30.1"` is the sole dependency) — NOT native. Single-file program: `/home/user/dao.fun/programs/proposal-gate/src/lib.rs` (~318 lines).

**Workspace** (`/home/user/dao.fun/programs/Cargo.toml`): `[workspace] members = ["proposal-gate"]`, resolver 2, and the safety baseline applied at the **workspace profile level**: `[profile.release] overflow-checks = true, lto = "fat", codegen-units = 1`. A new launchpad program should be added as a second member here (the README at `/home/user/dao.fun/programs/README.md` already names a planned `launch-coordinator` sibling). `programs/Cargo.lock` is committed.

**Member Cargo.toml** (`/home/user/dao.fun/programs/proposal-gate/Cargo.toml`): `crate-type = ["cdylib", "lib"]`, features `no-entrypoint` / `no-idl` / `cpi = ["no-entrypoint"]`.

**Instruction set** (`#[program] pub mod proposal_gate`):
- `initialize(ctx, realm: Pubkey, governance: Pubkey, mode: u8, whitelist: Vec<Pubkey>)` — creates the Gate PDA once per realm; whitelist 1..=16 (`MAX_WHITELIST = 16`), immutable after init.
- `ratchet(ctx, new_mode: u8)` — INV-11 one-way mode ratchet (guarded 0 → council 1 → cypherpunk 2 → sovereign 3); required signer is the **governance PDA** (`has_one = governance` + `Signer`), which only signs via executed proposals.
- `validate_transaction(ctx)` — permissionless crank: manually parses a real spl-governance `ProposalTransactionV2` account (owner check against `SPL_GOVERNANCE_ID`, account-type tag 13, then a fully bounds-checked `Reader` struct), whitelist-checks every outer program, unwraps Squads `vaultTransactionCreate` payloads (discriminator `[48,250,78,168,208,226,218,211]`) and whitelist-checks every inner program; refuses buffered messages (`TX_BUFFER_CREATE_DISC [245,201,113,108,37,63,29,89]`) and ALTs. Success `init`s a Clearance PDA.

**PDA seeds**: Gate = `[b"gate", realm]`; Clearance = `[b"clearance", proposal_transaction_pubkey]`. Bumps stored on the accounts and re-validated (`bump = gate.bump`). Accounts use `#[derive(InitSpace)]` with `#[max_len(MAX_WHITELIST)]` on the Vec.

**Program-id management**: `declare_id!("3QgQJ4EufHygGPMSBg4tD1Jzi1tEfyrFH4yXH3w8pBvg")` from a **throwaway key** (D-029); `programs/target/` is gitignored because cargo-build-sbf drops a PRIVATE program-id keypair in `target/deploy/` — never commit it. The real ID is regenerated at first devnet deploy. Foreign trusted IDs are hardcoded as `Pubkey::new_from_array([...])` byte arrays because **anchor 0.30 does not re-export the `pubkey!` macro**.

**Build pipeline** (D-029, no build script in-repo — commands are conventions in DECISIONS.md/test headers): solana-cli 4.0.1 / **cargo-build-sbf 4.0.0** (Anza stable installer) / **platform-tools v1.53** / anchor-lang 0.30.1. Proxy quirk: cargo-build-sbf's downloader fails on the egress-proxy CA — curl-fetch `platform-tools-linux-x86_64.tar.bz2` and extract into `~/.cache/solana/v1.53/platform-tools/`.

**How the .so gets into fixtures**: compiled artifact is gzipped and committed as `/home/user/dao.fun/tests/fixtures/proposal_gate.so.gz` (same convention as the mainnet dumps produced by `scripts/dump-mainnet-programs.ts` — gzip level 9, ~10x compression). The test harness (`tests/helpers/bankrun-harness.ts` lines 78–90) inflates every `*.so.gz` in `tests/fixtures/` on startup and sets `process.env.SBF_OUT_DIR = FIXTURES` so solana-bankrun's `start([{name, programId}])` finds them by name. Tests load the gate with `startCtx([{ name: "proposal_gate", programId: GATE_PROGRAM_ID }])`. CI needs no Rust toolchain.

## 2. packages/sdk (@daofun/sdk)

CommonJS, `main: dist/index.js` (must `pnpm --filter @daofun/sdk build` before dependents see changes), plus **source subpath exports** for browser-safe modules (`./launch-form`, `./matrix`, `./pda`, `./constants`, `./types`, `./vsr`, `./treasury`, `./governance`, `./rails/pumpfun` map to `./src/*.ts`). Dependencies pinned exactly: `@coral-xyz/anchor 0.30.1`, `@pump-fun/pump-sdk 1.36.0`, `@pump-fun/pump-swap-sdk 1.17.0`, `@solana/spl-governance 0.3.28`, `@solana/spl-token 0.4.14`, `@solana/web3.js 1.98.4`, `@sqds/multisig 2.1.4`, `bn.js 5.2.3`, `@noble/hashes 1.8.0`.

**Modules** (all under `/home/user/dao.fun/packages/sdk/src/`, barrel `index.ts`):
- `constants.ts` — program IDs: PUMP (`6EF8rrec…`), PUMP_AMM (`pAMMBay6…`), PUMP_FEES (`pfeeUxB6…`), SPL_GOVERNANCE (`GovER5…` — a FORK, see D-032), VSR (`vsr2nf…`), SQUADS_V4 (`SQDS4ep…`), MERKLE_DISTRIBUTOR (`mERKcfx…`, immutable).
- `pda.ts` — `derivePumpCreatorVault` (`["creator-vault", creator]`, hyphen), `derivePumpAmmCreatorVaultAuthority` (`["creator_vault", …]`, underscore), `deriveRealm`, `deriveGovernance`, `deriveNativeTreasury`, `deriveVsrRegistrar` (object-first seed order — verified on the real binary), `realmNameForMint` (first 32 base58 chars, D-001), `deriveGovernanceChainFromMint` (advance-derivation: realm→governance→nativeTreasury from mint alone).
- `rails/pumpfun.ts` — `class PumpFunRail implements LaunchRail`, wraps `@pump-fun/pump-sdk` (`PumpSdk`/`OnlinePumpSdk`): `buildCreateTokenIxs` (createV2 / createV2AndBuy, creator = Squads vault PDA passed as ARG not signer — INV-1), `buildCurveCollectIx` (collectCreatorFeeV2, zero signers — INV-2), `buildConsolidateAmmFeesIx` (transferCreatorFeesToPumpV2), `buildCollectFeesIxs`, `buildFeeSharesAtLaunchIxs` (gated OFF — GATE 0c determined impossible for PDA creators), `decodeFeeShares`. Reaches into pump-sdk's private offline anchor Programs via a structural type cast.
- `treasury.ts` — Squads v4: `deriveTreasuryPdas(createKey)`, `fetchProgramConfigTreasury(connection)`, `buildCreateTreasuryIx` (multisigCreateV2, threshold 1, sole member = predicted native treasury, configAuthority null, rentCollector = native treasury).
- `matrix.ts` — `TIER_FLOORS` (micro/small/mid/large), `holdUpFloorSeconds(mode, tier)`, `resolveGovernanceParams`.
- `governance.ts` — `buildCreateDaoIxs` (full DAO ceremony via spl-governance `with*` helpers + VSR ixs; returns ordered `groups: {council, realmSetup, governanceSetup}`); re-exports `MintMaxVoteWeightSource` (borsh class-identity trap).
- `vsr.ts` — hand-rolled VSR instruction builders (deployed VSR has legacy-anchor IDL): `buildCreateRegistrarIx`, `buildConfigureVotingMintIx`, `buildCreateVoterIx`, `buildCreateDepositEntryIx`, `buildDepositIx`, `buildWithdrawIx`, `buildUpdateVoterWeightRecordIx`, `buildCloseDepositEntryIx`, `buildCloseVoterIx`, `deriveVsrVoter`, `deriveVsrVoterWeightRecord`; browser-safe `anchorDiscriminator` via @noble/hashes (`sha256("global:<name>")[:8]`).
- `execution-adapter.ts` — the custody seam: `wrap(innerIxs, WrapContext)` → 4-ix Squads chain (vaultTransactionCreate/proposalCreate/proposalApprove/vaultTransactionExecute), `wrapBuffered` (chunked transaction-buffer variant, sha256-pinned), `unwrap` (recovers effective inner set for INV-9 hashing/decode), `fetchNextTransactionIndex`.
- `proposal.ts` — `buildProposeIxs`: one call → full spl-governance proposal (withCreateProposal + one withInsertTransaction per wrapped ix + withSignOffProposal), descriptionLink == instruction-set hash (D-017), auto-switches plain→buffered at `PLAIN_CREATE_DATA_BUDGET = 500` bytes, supports `directIxs` (native-treasury-signed legs, D-022).
- `actions.ts` — the fixed 6.8 menu: `buildGrantIxs`, `buildBurnIxs`, `buildBuybackIxs` (curve), `buildAmmBuybackIxs` + `buildProvideLiquidityIxs` (PumpSwap, two-leg vault/treasury staging via `AmmActionLegs`), `buildDistributeIxs`, `buildSetParamIxs` (whitelist `SET_PARAM_WHITELIST`), `DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n`, `promoteExtendAccountUser` writable-promotion fix.
- `merkle-distributor.ts` — `buildClaimTree`, `verifyClaimProof`, `deriveDistributor`, `deriveClaimStatus`, `buildNewDistributorIx`, `buildNewClaimIx`, `buildClawbackIx` against the immutable Jito deployment.
- `snapshot.ts` — `proRataShares` (pure bigint pro-rata math).
- `artifact-hash.ts` — `computeInstructionSetHash` (sha256 over programId|keys+flags|data in execution order — INV-9 anchor).
- `launch-form.ts` — framework-free `validateLaunchForm`, `hashBadge`, `executeButtonState` (shared client/server).
- `types.ts` — `LaunchRail` interface (**the rail abstraction a new launchpad would implement**: `buildCreateTokenIxs` / `buildCollectFeesIxs` / `deriveCreatorVault`), `LaunchParams` (note `rail: "pumpfun" | "meteora-dbc"` already anticipates a second rail), `GovernanceMode`, `MarketCapTier`, `TreasuryRef`, `LaunchResult`, `SweepResult`.

**Tx-building patterns**: every builder is OFFLINE and returns `TransactionInstruction[]` (or grouped arrays); callers assemble legacy `Transaction`s. **Versioned txs (v0 + address-lookup-table)** are used only at the SENDING edge for oversized inserts: `sendWithAlt` in `tests/helpers/bankrun-harness.ts` and the mainnet gate scripts. **Priority fees**: `ComputeBudgetProgram.setComputeUnitLimit({units: 400_000})` + `setComputeUnitPrice({microLamports: 50_000})` — hardcoded convention in keeper service and every mainnet/devnet script; no dynamic fee estimation exists.

**Consumption**: backend imports the built barrel (`@daofun/sdk` → dist/); frontend (`app/`) imports ONLY the source subpaths (`@daofun/sdk/launch-form`, `/pda`, `/treasury`, `/governance`, `/rails/pumpfun`, `/matrix`) with `transpilePackages: ["@daofun/sdk"]` in next.config.mjs — the browser never carries chain deps beyond what those pull (launch flow builds server-side; wallet signs raw bytes per D-028).

## 3. packages/keeper (@daofun/keeper)

A **library, not a daemon** — no cron/setInterval anywhere; scheduling is the operator's concern. Three files:
- `src/keeper.ts` — `sweepVault(vault, deps)` (idempotent permissionless fee sweep; refuses any non-keeper signer = INV-2; retry with exponential backoff; hard error if vault shrinks; records GROSS delta = INV-8) and `runTick(vaults, deps, onError)` (one scheduler tick, per-vault failure isolation). Deps injected via `KeeperDeps` interface for offline testing.
- `src/service.ts` — `makeKeeperDeps(cfg)` wires real `Connection` + `PumpFunRail` + keypair; builds txs with CU limit 400k + priority 50k µlamports.
- `src/observability.ts` — `KeeperMonitor` (consecutive-failure escalation, exactly-one-alert-per-outage, bigint counters, `snapshot()` for metrics) and `runMonitoredTick`.

**Launchpad relevance**: a graduation crank can copy this exact shape — pure `sweepVault`-style function + injected deps + `runTick` loop + `KeeperMonitor`, with the caller supplying the schedule.

## 4. scripts/ (all tsx, run from repo root)

- `init-wallets.ts` — idempotent devnet wallet init (`pnpm init-wallets`); exports `loadOrCreateKeypair(dir, name)` (0o600 keypair files in gitignored `.wallets/`), `airdropWithBackoff`, `initWallets`; `BASE_WALLETS = ["deployer","keeper","protocol-treasury","buyer"]`.
- `devnet-validate-creator.ts` — GATE 0a devnet validation (`pnpm gate:0a`): PDA-creator + permissionless collect end-to-end, evidence JSON to `.gate-evidence/`.
- `gate-0a-cleanup.ts` / `gate-0a-continue.ts` — gate-0a resumption/cleanup.
- `dump-mainnet-programs.ts` — dumps the 8 mainnet program binaries (spl_governance, squads_v4, vsr, token_2022, pump, pump_fees, pump_amm, merkle_distributor) as `tests/fixtures/<name>.so.gz` (strips 45-byte ProgramData header, gzip -9), plus Squads ProgramConfig and live pump/AMM state accounts as JSON. Idempotent, `--force` to refresh.
- `mainnet-gate1-sovereign.ts` / `-p2.ts` — resumable mainnet GATE 1 runs (real DAO + custody-chain proposal), stage-checkpointed evidence.
- `snapshot-holders.ts` — live holder snapshot → pro-rata shares + merkle root (read-only).
- `jup-ultra-swap.ts`, `serve-frontend-mainnet.ts` — operator utilities.

## 5. DECISIONS.md D-026/D-028/D-029/D-030 — existing infrastructure

- **D-026 (holder snapshot service)**: sdk `proRataShares` (pure bigint math) + backend sources in `packages/backend/src/holder-snapshot.ts`: `RpcHolderSnapshot` (gPA memcmp mint@0, 72-byte dataSlice, withContext slot pinning; auto-fallback to `getTokenLargestAccounts` that REFUSES at the top-20 cap) and `DasHolderSnapshot` (Helius, cursor-paginated, refuses >2^53 JSON numbers); `makeHolderSnapshotSource` picks DAS when HELIUS_API_KEY set. Public mainnet RPC is index-excluded (-32010) AND rate-limited for token gPA. Snapshot is off-chain INPUT; the DAO votes on the merkle root (INV-9).
- **D-028 (server-built txs / browser signing)**: `packages/backend/src/tx-builder.ts` — pure unsigned-tx builders (`buildDepositGoverningTokensTx`, `buildCastVoteTx`) returning base64; `RpcGovernanceTxSource` resolves ALL chain context server-side (browser sends only proposal+wallet+approve) and `submit`s raw signed bytes. Wallet is ALWAYS fee payer and only signer (test-asserted). Client side is ~100 lines of wallet-standard protocol (`app/lib/wallet-standard.ts`) operating on raw bytes — no web3.js in the page. Proven against the real binary in `tests/wallet-vote.integration.test.ts`. Routes: `POST /chain/txs/{deposit,cast-vote,submit}`. **A launchpad buy/sell UI can ride this exact seam.**
- **D-029 (program build pipeline)**: proven end-to-end — cargo-build-sbf 4.0.0 / solana-cli 4.0.1 / platform-tools v1.53 / anchor-lang 0.30.1; proxy-CA workaround (curl platform-tools into `~/.cache/solana/v1.53/platform-tools/`); workspace-level overflow-checks; compiled artifact loads in the SAME bankrun harness as deployed binaries; gzipped fixture convention; program-id keypair hygiene (target/ gitignored, throwaway declare_id, real ID at first devnet deploy).
- **D-030 (on-chain validation engine)**: proposal-gate v1 shipped and proven on real binaries — Gate PDA config, permissionless `validate_transaction` crank (checked byte reader, no borsh dep; parses ProposalTransactionV2 AND the embedded Squads TransactionMessage; refuses smuggled inner programs, buffered messages, ALTs), Clearance PDAs, structural one-way `ratchet` signed by the governance PDA. Honest limits: program-level whitelist only (no per-instruction byte validation yet); clearances not yet consumed (the enforcement seam is the pending D-032 operator decision).

## Version pins (VERSIONS.md + D-029)

TS: node >=22, pnpm 10.33.0, @pump-fun/pump-sdk 1.36.0 (ESM broken — CJS used), @pump-fun/pump-swap-sdk 1.17.0, @solana/spl-governance 0.3.28, @sqds/multisig 2.1.4, @solana/web3.js 1.98.4 (v1.x required by SDKs), @solana/spl-token 0.4.14, @coral-xyz/anchor 0.30.1, bn.js 5.2.3, solana-bankrun 0.4.0, fast-check 4.5.3. Rust side (D-029, not in VERSIONS.md): solana-cli 4.0.1, cargo-build-sbf 4.0.0, platform-tools v1.53, anchor-lang 0.30.1.

## Test/bankrun harness worth knowing about

`/home/user/dao.fun/tests/helpers/bankrun-harness.ts` is the shared integration rig: `startCtx`/`startPumpCtx` (real mainnet binaries incl. the full pump stack + live state accounts), `createDao` (full DAO via production builders), `proposeInner`/`proposeSweep` (production buildProposeIxs), `castCommunityYes`/`castCouncilVeto`, `finalizeAfterVotingWindow`, `executeAll`, `warpSeconds` (clock control), `sendWithAlt` (v0+ALT), `sendMeasured` (CU accounting), `prefundMissingWritables`, `chainHashOf`. A new launchpad program's integration tests should extend this harness (add `{name: "<prog>", programId}` to startCtx extras, commit `tests/fixtures/<prog>.so.gz`).

## KEY FILES
- /home/user/dao.fun/programs/proposal-gate/src/lib.rs — The one existing Anchor program (0.30.1): initialize/ratchet/validate_transaction, gate+clearance PDAs, checked byte Reader, byte-array program-id consts — the template for a new program
- /home/user/dao.fun/programs/Cargo.toml — Rust workspace a new launchpad program must join; overflow-checks=true, lto=fat, codegen-units=1 at workspace profile level (6.9 safety baseline)
- /home/user/dao.fun/programs/proposal-gate/Cargo.toml — Member crate config: cdylib+lib, no-entrypoint/no-idl/cpi features, anchor-lang 0.30.1 only
- /home/user/dao.fun/packages/sdk/src/types.ts — LaunchRail interface (buildCreateTokenIxs/buildCollectFeesIxs/deriveCreatorVault) — the rail seam a new launchpad rail implements; LaunchParams already types rail: 'pumpfun' | 'meteora-dbc'
- /home/user/dao.fun/packages/sdk/src/rails/pumpfun.ts — PumpFunRail — reference rail implementation wrapping @pump-fun/pump-sdk (create_v2, fee collect, AMM consolidation)
- /home/user/dao.fun/packages/sdk/src/pda.ts — All PDA derivations incl. deriveGovernanceChainFromMint (advance-derivation rule) and pump creator-vault seeds
- /home/user/dao.fun/packages/sdk/src/constants.ts — Pinned program IDs (pump, pump_amm, pump_fees, spl-governance fork, VSR, Squads v4, Jito merkle distributor)
- /home/user/dao.fun/packages/sdk/src/execution-adapter.ts — wrap/wrapBuffered/unwrap — the Squads custody chain seam; fetchNextTransactionIndex
- /home/user/dao.fun/packages/sdk/src/proposal.ts — buildProposeIxs — one call from inner ixs to full governance proposal; plain/buffered auto-switch at 500-byte create-data budget
- /home/user/dao.fun/packages/sdk/src/actions.ts — The 6.8 action menu builders (grant/burn/buyback/AMM buyback/provideLiquidity/distribute/setParam) — vault/treasury two-leg staging pattern for account-heavy AMM ixs
- /home/user/dao.fun/packages/sdk/src/vsr.ts — Hand-rolled anchor-instruction builders against a no-IDL deployed program — the pattern to copy when wrapping a program without a usable IDL; browser-safe anchorDiscriminator
- /home/user/dao.fun/packages/sdk/src/governance.ts — buildCreateDaoIxs — full DAO ceremony in ordered tx-safe groups
- /home/user/dao.fun/packages/sdk/src/treasury.ts — Squads v4 treasury creation (buildCreateTreasuryIx, deriveTreasuryPdas, fetchProgramConfigTreasury)
- /home/user/dao.fun/packages/sdk/src/artifact-hash.ts — computeInstructionSetHash — INV-9 canonical hash both proposer and verifier use
- /home/user/dao.fun/packages/sdk/package.json — Pinned deps + the dual export pattern: dist barrel for node, src subpath exports for the browser bundle
- /home/user/dao.fun/packages/keeper/src/keeper.ts — sweepVault/runTick — injected-deps crank pattern to copy for a graduation keeper
- /home/user/dao.fun/packages/keeper/src/service.ts — makeKeeperDeps — Connection wiring, CU limit 400k + priority fee 50k µlamports convention
- /home/user/dao.fun/packages/keeper/src/observability.ts — KeeperMonitor — consecutive-failure alert escalation + metrics snapshot
- /home/user/dao.fun/tests/helpers/bankrun-harness.ts — Shared bankrun rig: loads *.so.gz fixtures (SBF_OUT_DIR), createDao, proposeInner, executeAll, warpSeconds, sendWithAlt (v0+ALT), sendMeasured (CU)
- /home/user/dao.fun/tests/stage3-gate.integration.test.ts — How our own compiled program is tested against real deployed binaries (raw ix construction with sha256 discriminators)
- /home/user/dao.fun/scripts/dump-mainnet-programs.ts — Produces tests/fixtures/*.so.gz + state-account JSON dumps (gzip -9, 45-byte ProgramData header strip)
- /home/user/dao.fun/scripts/init-wallets.ts — loadOrCreateKeypair + idempotent devnet wallet/airdrop init (pnpm init-wallets); keys in gitignored .wallets/
- /home/user/dao.fun/scripts/devnet-validate-creator.ts — Gate-style devnet validation script pattern with .gate-evidence JSON output (pnpm gate:0a)
- /home/user/dao.fun/packages/backend/src/tx-builder.ts — D-028 server-built unsigned-tx seam (base64 in, wallet signs raw bytes, backend submits) — reusable for launchpad buy/sell UI
- /home/user/dao.fun/packages/backend/src/holder-snapshot.ts — D-026 RpcHolderSnapshot/DasHolderSnapshot sources with slot pinning and truncation refusal
- /home/user/dao.fun/packages/backend/src/launch-steps.ts — buildLaunchSteps — the resumable launch step machine a launchpad's launch flow would extend (injected LaunchStepDeps)
- /home/user/dao.fun/VERSIONS.md — TS-side exact version pins + verified program-ID table
- /home/user/dao.fun/DECISIONS.md — D-026 (snapshots), D-028 (browser signing), D-029 (Rust toolchain: cargo-build-sbf 4.0.0 / platform-tools v1.53 / anchor-lang 0.30.1), D-030 (validation engine), D-031/D-032 (governance fork finding)

## REUSABLE
- LaunchRail interface + PumpFunRail @ packages/sdk/src/types.ts, packages/sdk/src/rails/pumpfun.ts — A new bonding-curve launchpad slots in as a second rail implementation (LaunchParams.rail already types 'meteora-dbc' as a placeholder); or as its own rail wrapping the NEW on-chain program
- programs/ Cargo workspace with safety-baseline profile @ programs/Cargo.toml — Add the new program as a member; overflow-checks/lto/codegen-units inherited automatically. anchor-lang 0.30.1 pinned; use Pubkey::new_from_array byte arrays for foreign IDs (no pubkey! macro in 0.30)
- bankrun integration harness (startCtx/startPumpCtx, createDao, proposeInner, executeAll, warpSeconds, sendMeasured, sendWithAlt) @ tests/helpers/bankrun-harness.ts — Loads gzipped fixtures via SBF_OUT_DIR; the pump stack + live global/fee-config accounts are already fixture-dumped, so a bonding-curve program can be tested against the REAL pump programs for graduation/migration flows
- Fixture pipeline: cargo-build-sbf -> gzip -> tests/fixtures/<name>.so.gz @ scripts/dump-mainnet-programs.ts (mainnet side), D-029 (our-program side) — Commit the compiled .so gzipped so CI needs no Rust toolchain; harness auto-inflates
- buildProposeIxs + wrap/unwrap ExecutionAdapter + computeInstructionSetHash @ packages/sdk/src/proposal.ts, execution-adapter.ts, artifact-hash.ts — Any DAO-governed launchpad admin action (e.g. setting curve params by vote) gets INV-9 hashing, hold-up, and Squads custody for free
- Keeper crank pattern (sweepVault/runTick/KeeperMonitor/makeKeeperDeps) @ packages/keeper/src/ — Graduation crank should copy this: pure logic + injected KeeperDeps, per-item failure isolation, exactly-once alert escalation, CU 400k + 50k µlamports priority fee, bigint everywhere; no scheduler included — caller drives ticks
- Server-built-tx seam (unsigned base64 -> wallet-standard raw-byte signing -> submit) @ packages/backend/src/tx-builder.ts + app/lib/wallet-standard.ts — Launchpad buy/sell/claim UI rides the same seam; invariant: wallet is fee payer and ONLY signer, all chain context resolved server-side
- Hand-rolled anchor ix builders + anchorDiscriminator (sha256 global:<name>[:8]) @ packages/sdk/src/vsr.ts, merkle-distributor.ts — The pattern for SDK-side builders against the new program before/without an IDL; use @noble/hashes for browser safety, node:crypto only in server-only modules
- Wallet + evidence scripts @ scripts/init-wallets.ts (loadOrCreateKeypair, airdropWithBackoff), scripts/devnet-validate-creator.ts (.gate-evidence JSON convention) — Devnet validation of the new program should follow the gate-script shape: idempotent, resumable, evidence JSON for GATES.md
- resolveGovernanceParams / TIER_FLOORS / validateLaunchForm @ packages/sdk/src/matrix.ts, launch-form.ts — Shared client+server validation pattern (framework-free module exported as a source subpath)

## GOTCHAS
- STRICT ordering: workspace packages resolve through dist/ — run `pnpm --filter @daofun/sdk build` (and backend) before integration/e2e tests pick up source changes; the e2e stub server reuses stale servers unless killed
- programs/target/ is gitignored because cargo-build-sbf drops a PRIVATE program-id keypair in target/deploy — never commit it; declare_id in-tree is a throwaway, real ID minted at first devnet deploy
- cargo-build-sbf's built-in platform-tools downloader fails on the proxy CA — curl-fetch platform-tools-linux-x86_64.tar.bz2 into ~/.cache/solana/v1.53/platform-tools/ manually (D-029)
- anchor-lang 0.30 does not re-export the pubkey! macro — hardcode foreign program IDs as Pubkey::new_from_array byte arrays (see proposal-gate lib.rs)
- The deployed mainnet spl-governance (GovER5…, v3.1.4) is a FORK: public solana-program-library master has DIVERGED — do NOT build governance instructions from public-master enum indices (D-031/D-032); verify everything against the dumped binary in bankrun
- bankrun dedups byte-identical transactions — disambiguate repeated sends with a varying CU-limit instruction (see action-distribute test line 205: 200_000 + nonce)
- Public RPC from this datacenter: token-program getProgramAccounts is index-excluded (-32010) AND per-method rate-limited — use Helius/keyed RPC for live holder reads (D-026)
- Governance InsertTransaction has a hard 1232-byte tx budget: VaultTransactionCreate data over ~500 bytes forces the buffered Squads chain (buildProposeIxs auto-switches); ~19+ account instructions need v0+ALT sending (sendWithAlt); ~26-account AMM ixs cannot be Squads-wrapped at all and ride direct treasury-signed legs (D-022)
- @pump-fun/pump-sdk 1.36.0 ESM build is broken — everything is CommonJS (D-002); web3.js is pinned to 1.x because the vendor SDKs require it
- Squads message privilege normalization: signer/writable flags are unified per-account across the whole inner set, so INV-9 hashes must be computed from unwrap(wrap(ixs)), never the raw inner ixs (D-027) — any new hashing must follow this
- The proposal-gate refuses buffered Squads messages and ALTs by design (cannot be validated from one account) — guarded proposals must use the plain wrap; a new program parsing proposal bytes inherits the same constraint
- node:crypto vs browser: modules that may reach the client bundle must use @noble/hashes (vsr.ts pattern); execution-adapter/merkle-distributor/artifact-hash use node:crypto and are server-only
- VSR registrar PDA seed order is OBJECT-FIRST ([realm, "registrar", mint]) — the literal-first order fails on the real binary with 'signer privilege escalated'; always verify PDA seeds against deployed binaries, not source repos
- Pump seeds differ by venue: curve creator vault uses "creator-vault" (hyphen), AMM uses "creator_vault" (underscore)
- Rent-floor discipline everywhere (D-009): DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n; the native treasury needs ~6M lamports prefund for Squads execution rent (D-016); every fund-moving builder validates the floor at build time
- Repo doctrine: tests BEFORE code on anything touching funds/PDAs/governance; commit messages end with the session URL footer; push only to branch claude/spec-driven-repo-reset-yqzenh; mainnet keys are disposable gas-only, keep 0.01725 SOL in deployer FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds
- VERSIONS.md does NOT carry the Rust toolchain pins — those live only in D-029 (solana-cli 4.0.1, cargo-build-sbf 4.0.0, platform-tools v1.53, anchor-lang 0.30.1)
- Keeper package has no scheduler and no bin entry — runTick/runMonitoredTick are called by an external driver; do not assume a cron exists when planning the graduation crank
