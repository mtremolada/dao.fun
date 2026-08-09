# DECISIONS.md — verification log & recorded deviations

Every (verify)-marked item from the spec is resolved here with evidence.
Format: D-NNN, date, finding, evidence, consequence.

## D-001 — Advance-derivation rule amended: realm name = first 32 base58 chars of mint (2026-06-11)

**Spec said:** `realm_name := the token mint pubkey (base58)` (Section 1,
load-bearing).

**Finding:** impossible as written. A base58-encoded 32-byte pubkey is 43–44
characters; Solana PDA seeds are capped at 32 bytes per seed.
`PublicKey.findProgramAddressSync([Buffer.from("governance"), Buffer.from(mintBase58)], GOV)`
throws `Max seed length exceeded` (verified empirically against
@solana/web3.js 1.98.4; pinned by test
`packages/sdk/test/pda.test.ts` "full base58 mint pubkey exceeds max seed length").

**Decision:** `realm_name := mintBase58.slice(0, 32)` —
`realmNameForMint()` in `packages/sdk/src/pda.ts`. Still deterministic and
computable before the mint account exists (the load-bearing property), ~187
bits of entropy so collisions are not a practical concern. **Operator
attention requested at GATE 0a sign-off.**

## D-002 — @pump-fun/pump-sdk 1.36.0 ESM build is broken; CJS entry used (2026-06-11)

**Finding:** the package's ESM output imports `@pump-fun/agent-payments-sdk`,
whose published ESM is syntactically malformed (invalid `const {X} from "..."`
constructs). Vitest/Vite resolving the `import` condition fails at collection.
The CJS build (`dist/index.js`) is intact.

**Decision:** alias `@pump-fun/pump-sdk` to its CJS entry in vitest configs
(`require.resolve`). Node script execution via tsx (CJS mode) is unaffected.
Re-check on every pump-sdk upgrade.

## D-003 — PDA seed verifications against installed package source (2026-06-11)

All pinned by `packages/sdk/test/pda.test.ts` (13 green tests, no network):

| Item | Spec claim | Verified against | Result |
|---|---|---|---|
| Pump creator vault | `["creator-vault", creator]` (hyphen) | pump-sdk `src/pda.ts` `creatorVaultPda` | CONFIRMED |
| PumpSwap creator vault | `["creator_vault", coin_creator]` (underscore) | pump-sdk `ammCreatorVaultPda` | CONFIRMED |
| Realm | `["governance", realm_name]` | spl-governance `GOVERNANCE_PROGRAM_SEED = 'governance'` | CONFIRMED |
| Governance | `["account-governance", realm, governed_seed]` | spl-governance `withCreateGovernance.js` | CONFIRMED |
| Native treasury | `["native-treasury", governance]` | spl-governance `getNativeTreasuryAddress` (used as oracle in test) | CONFIRMED |
| VSR registrar | ~~`["registrar", realm, community_mint]`~~ | the deployed binary (GATE 1 bankrun VSR leg) — order is `[realm, "registrar", mint]` | CORRECTED: D-018 |
| Squads vault | `getVaultPda(multisig, index)` = `["multisig", multisigPda, "vault", u8(index)]` | @sqds/multisig `lib/index.js` seeds + oracle in test | CONFIRMED |
| Pump program IDs (3) | Section 1 table | pump-sdk `src/sdk.ts` constants, asserted in test | CONFIRMED |

## D-004 — pump createV2 mints are Token-2022 (2026-06-11)

**Finding:** pump-sdk `createV2Instruction` hardcodes
`tokenProgram: TOKEN_2022_PROGRAM_ID`; `createV2AndBuyInstructions` derives
the user ATA with Token-2022 and fixes buy slippage at 1%. Downstream code
(GATE 0a script, future PumpFunRail) must use `TOKEN_2022_PROGRAM_ID` for
post-create interactions with v2 mints, and `collectCreatorFeeV2` for fee
collection.

**Consequence:** GATE 0b (Token-2022 on curve) may be partially moot for v2
creates — the base path is already Token-2022. The 0b question narrows to
transfer-fee extensions specifically. Re-scope 0b when reached.

## D-005 — LaunchParams.launcher amendment (2026-06-11)

pump `create_v2` requires a `user` signer (IDL: signers are `mint` and
`user` only; `creator` is an instruction ARG, not an account). The spec's
Section 4 `LaunchParams` had no launcher field, so rails could not build the
create instruction. Added optional `launcher: PublicKey`; PumpFunRail throws
if absent. INV-1 is strengthened by this verification: the creator
structurally cannot be a signer.

## D-006 — collect_creator_fee_v2 has ZERO signer accounts (2026-06-11)

Verified from the pump IDL: every account in `collect_creator_fee_v2`
(including `creator`) is `signer: false`. INV-2 is structural at the program
level; the only tx signer is the fee-payer. Pinned by
`test/pump-rail.test.ts` "signer set is a subset of {fee-payer}".

## D-007 — Fee-sharing config creation requires creator as payer (GATE 0c risk flag) (2026-06-11)

pump-sdk `createFeeSharingConfig` sets `payer: creator`. With our PDA
creator (Squads vault), that account cannot sign a launch-ceremony tx. This
makes GATE 0c likely to FAIL as specified unless the fees program accepts a
separate payer or config-via-CPI. Flagging now so the 0c result is not a
surprise; MVP protocol revenue may be launch-fee-only, per the spec's
fallback. `buildFeeSharesAtLaunchIxs` stays gated (FeatureUnavailable).

## D-008 — Operator override: GATE 0a executed on mainnet with operator funds (2026-06-11)

The devnet faucet was IP-rate-limited in the execution environment. The
operator explicitly directed a mainnet run funded with his own USDC
(~$4.60) sent to an agent-generated disposable gas wallet
(`FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds`), swapped gasless to SOL
via Jupiter Ultra (JupiterZ RFQ; sig
`5gMHW95mBXxRZ2W7VY6c737e6NpAwCXckVbEQHzh4SyBiVeERHQXx7JSCso8cVUqmYanXZtwiAFDzwMWjFcM4W1`).
This deviates from spec Section 11 ("no mainnet key is agent-generated")
for a *gas-only, disposable* key — not a revenue or upgrade key — at the
operator's explicit, repeated instruction. All liquid funds (0.0593 SOL)
were swept back to the operator wallet immediately after the run; ATAs
closed. Gate evidence in GATES.md.

## D-009 — Rent-exempt floors are a real constraint on small fund paths (2026-06-11)

Two encounters during the mainnet run:
1. 0-data system accounts (pump creator-fee vault, Squads vault PDA)
   cannot end a tx below ~890,880 lamports; tiny creator-fee transfers
   into fresh vaults would fail. Fix applied: rent pre-fund step in the
   gate script.
2. A fee payer cannot drop below the rent floor either: the buyer leg
   failed sim with "insufficient funds for rent" and was resumed with a
   smaller buy.

**Consequences for Stage 1:** the keeper (6.5) must treat
`balance - rentMin` as spendable, never `balance`; the orchestrator (6.6)
must budget rent floors for every account it touches; sweep logic must
leave rent-min in accounts that persist. Add explicit tests at the u64 and
rent boundaries (INV-6 suite).

## D-010 — VSR IDL resolved and vendored; instructions built manually (2026-06-11)

The deployed VSR (`vsr2nf...`) publishes **no on-chain anchor IDL**
(verified via `Program.fetchIdl` against mainnet). IDL obtained from
`@blockworks-foundation/voter-stake-registry-client@0.2.3` (program v0.2.1)
and vendored at `packages/sdk/src/idl/vsr.json`. That IDL is legacy-anchor
format, incompatible with @coral-xyz/anchor 0.30's `Program`, so
`create_registrar` and `configure_voting_mint` are built manually
(`src/vsr.ts`): sha256("global:<name>")[0..8] discriminators + borsh args,
account lists pinned to the IDL. Layout is asserted byte-level in
`test/governance.test.ts`. On-chain validation lands with the Stage 1
integration suite. Scaled factors use 1e9 == 1.0 (VSR convention).

## D-011 — spl-gov v3 veto semantics verified (2026-06-11)

`GovernanceConfig` in @solana/spl-governance 0.3.28 carries
`councilVetoVoteThreshold` (council vetoes community proposals) and
`communityVetoVoteThreshold` (the reverse). Our modes map to:
council mode -> councilVetoVoteThreshold = YesVotePercentage(vetoPercent);
all other modes -> Disabled (and no council mint exists — structural).
Community veto of council proposals: Disabled (council cannot pass its own
proposals anyway: councilVoteThreshold = Disabled, veto-only council).

## D-012 — Parameters the spec left open, fixed in code (2026-06-11)

- **Voting duration** is absent from the Section 5 tier table. Default
  `baseVotingTime` = 3 days (`DEFAULT_BASE_VOTING_TIME_SECONDS`),
  overridable per launch.
- **Quorum semantics**: spec's `quorumPercent` maps to
  `communityVoteThreshold = YesVotePercentage(quorum)` — i.e. YES votes
  must reach that share of max voter weight (VSR-scaled). This is the
  v3-native reading of "percent of max voter weight".
- **Vote tipping**: community Disabled (full voting window always — the
  cypherpunk "exit window" must never be shortened by early tipping);
  council Strict.
- `votingCoolOffTime` 0 and `depositExemptProposalCount` 0 for MVP.
  (`depositExemptProposalCount` superseded by D-015: now 10.)

## D-013 — Deployed VSR rejects Token-2022 mints; SPL Gov v3.1.4 accepts them with a caveat (2026-06-11, on-chain evidence)

Verified live on mainnet (free simulation + executed txs, evidence in
`.gate-evidence/gate1-sovereign-mainnet.json`):

- **VSR (`vsr2nf...`) is classic-SPL-Token-only.** `create_registrar` for a
  Token-2022 community mint fails with anchor error 3007
  (AccountOwnedByWrongProgram) — the program's `Account<Mint>` constraints
  predate Token-2022. Since ALL pump `createV2` mints are Token-2022, the
  spec's VSR-based lockup voting CANNOT work against the deployed VSR.
- **SPL Governance v3.1.4 (deployed `GovER5...`) supports Token-2022**
  community mints: realm creation initializes the holding account via the
  Token-2022 program, and `DepositGoverningTokens` works — but the deployed
  program requires the governing token MINT appended to the deposit /
  withdraw account list ("Expected mint account is required for Token-2022
  deposits and withdrawals"); JS sdk 0.3.28 omits it, so the ix is patched
  (see `retargetTokenProgram` + mint append in the gate script).

Consequences:
- `buildCreateDaoIxs` gained `communityVoterWeightAddin: null` — realms are
  built WITHOUT the VSR addin for Token-2022 mints; voting weight = plain
  deposited tokens (no lockup scaling). INV-4 (lockup-weighted voting) is
  therefore NOT enforceable at MVP with deployed programs; restoring it
  requires a custom voter-weight plugin (Stage 2/3 work) or a VSR upgrade.
- Production launch path must use the no-addin realm until then.

## D-014 — Mainnet smoke-run config deviations (2026-06-11, operator-funded GATE 1 partial)

Mainnet has no clock control, so the sovereign-mode e2e uses a smoke DAO on
the GATE 0a mint with: `baseVotingTime` 3600s (program minimum),
`MintMaxVoteWeightSource` Absolute(200k tokens) so a small holder can meet
the production quorum percent (25), proposal threshold 50k tokens, hold-up
0 (production-legal sovereign choice). Production values are pinned by unit
tests and unaffected; the Absolute max-vote-weight knob and the VSR
baseline knob added for this run are documented as smoke/test-scoped in
`CreateDaoParams`. Tier-floor hold-up/voting behavior over days remains
integration-suite work (clock-warp), per the plan.

## D-015 — Proposal security deposit: depositExemptProposalCount 0 -> 10 (2026-06-11, found live)

SPL Gov v3.1.4 charges a **refundable ~0.102 SOL security deposit per
proposal** when the config's `depositExemptProposalCount` is exhausted; our
MVP config of 0 made EVERY proposal cost ~0.102 SOL up front (discovered
when the smoke proposal failed: "insufficient lamports 33585574, need
101788720"). Anti-spam is already provided by the token proposal
threshold, so the default is now 10 (Realms' common default), pinned by
test. The deposit is recoverable via `RefundProposalDeposit` once the
proposal completes (wired into the gate script's cleanup).

## D-016 — Native treasury pays Squads rent at execution time (2026-06-11, found live)

When governance executes the ExecutionAdapter's wrapped Squads chain, the
**native treasury is the rent payer** for the accounts Squads creates:
`VaultTransactionCreate` (2,429,040 lamports for our 1-inner-ix sweep) and
`ProposalCreate` (2,046,240 lamports). The treasury's 890,880 prefund is
only its own rent floor, so execution fails with `insufficient lamports`
unless the treasury holds execution rent on top. Consequences:

- the launch flow (and any proposal UX) must ensure the native treasury
  holds ~0.005 SOL of execution headroom per Squads-wrapped proposal —
  prefund at launch and/or top up at proposal time;
- that rent stays locked in the Squads Transaction/Proposal accounts
  unless the multisig sets a `rentCollector` and the accounts are closed
  after execution (`vault_transaction_accounts_close`) — DONE:
  `buildCreateTreasuryIx` sets `rentCollector = nativeTreasury` (accepted
  by the real program in the bankrun suite), and the launch flow's
  `prefund-treasury` step funds the floor + one execution's headroom
  (`TREASURY_EXECUTION_PREFUND_LAMPORTS`);
- the gate script now funds the exact shortfall reported by simulation
  before each execute (verified live: two top-ups, then clean execution).

Also hardened in the same run (operational): a mid-stage abort must not
re-send completed legs — execute skips ProposalTransactions whose on-chain
`executionStatus` is already Success, and cleanup sub-steps guard on
on-chain state (`isRelinquished`, deposit amount, ATA existence).

## D-017 — Chain reader conventions (2026-06-11)

Spec 6.7's server side is a `ChainReader` seam in the backend (`/chain/*`
routes): RPC-backed in prod (`RpcChainReader`), fake in tests and the
Playwright stub server. Conventions it pins:

- **INV-9 chain side**: the proposal view's hash is recomputed by
  re-reading every ProposalTransaction from chain and UNWRAPPING the
  Squads plumbing before hashing — verified live against the GATE 1
  phase-2 proposal (`FJjnLM2...`): the production read path recomputed
  `76962352...` == the artifact hash.
- **Artifact discovery**: a proposal's `descriptionLink` carries the
  64-hex artifact hash (`publishedArtifactHash`), so the UI finds the
  artifact with no off-chain coordination. The gate-1 proposal predates
  this convention (empty descriptionLink) — the UI accepts a query-param
  override. DONE: the sdk `buildProposeIxs` builder publishes
  `descriptionLink = innerInstructionSetHash` (verified on the real
  governance program by the bankrun suite, which re-reads the proposal
  and matches the field), wraps through the ExecutionAdapter, and stamps
  the resolved hold-up on every ProposalTransaction. The canonical hash
  moved to the sdk (`computeInstructionSetHash`); the backend re-exports.
- **Vote power**: for no-addin realms (D-013) the dashboard reports
  `governingTokenDepositAmount` — deposit IS the vote weight until VSR
  lands.
- **Wallet adapter deliberately deferred**: the launch ceremony is
  backend-orchestrated (server signs), so the MVP UI needs no wallet;
  user-signed vote/execute from the browser is Stage 2 scope.

## D-018 — GATE 1 matrix on real binaries; two sdk bugs found (2026-06-11)

The council/cypherpunk/VSR legs run in solana-bankrun against the DEPLOYED
mainnet binaries (dumped by `scripts/dump-mainnet-programs.ts` into
`tests/fixtures/`, committed for hermetic CI). Clock warp gives the
assertions a live cluster can't: 72h hold-up refusal, lockup-weight decay.
Running the real programs immediately caught two bugs the unit suites
(which only check instruction SHAPES) could not:

1. **Ceremony ordering**: `createRealm` registers — and validates — the
   council mint, so the council-mint creation ixs must execute FIRST.
   `buildCreateDaoIxs` previously ordered them after realm setup; a
   council-mode launch would have failed its first transaction on
   mainnet. Fixed: `groups`/`ixs` now put council first; the order is
   part of the builder's contract.
2. **VSR registrar PDA seeds**: the deployed program derives the
   registrar as `[realm, "registrar", mint]` (object-first, like its
   voter PDA), not `["registrar", realm, mint]`. With the wrong order,
   `create_registrar` fails with "signer privilege escalated".
   CONSEQUENCE: the mainnet experiment behind D-013 ran with wrong seeds,
   so its failure proved nothing about Token-2022. Re-run cleanly in
   bankrun: `create_registrar` rejects a Token-2022 mint on the mint's
   OWNER (`AccountOwnedByWrongProgram`) — D-013's conclusion (no-addin
   realms for Token-2022 at MVP) stands, now on sound evidence.

Also: bankrun's program-test preloads classic SPL Token but not
Token-2022 — the dump script fetches it too. The CI integration job now
runs `pnpm test:integration` hermetically (no validator, no network).

## D-019 — GATE 0c determined on real binaries; size/CU machinery findings (2026-06-11)

GATE 0c verdict (evidence in GATES.md): **at-launch fee shares for a PDA
creator are impossible** — the deployed PumpFees binary refuses
`createFeeSharingConfig` from any payer that is not the coin creator
(`NotAuthorized`, and the payer is the instruction's only signer), so
D-007 is confirmed as a hard on-chain constraint and MVP protocol revenue
stays launch-fee-only. **But the DAO can configure its own fee sharing
post-launch**: the vault PDA satisfies the creator-signature requirement
via invoke_signed through the governance-executed Squads chain — create +
set {vault 90%, protocol 10%} executed atomically and decoded back.
Fee-sharing becomes a 6.8 menu action (build at first need), not a
launch-ceremony feature.

Machinery the gate forced, all now in the sdk/harness:

- **Insert size binds before CU.** A governance `InsertTransaction`
  carrying a plain `VaultTransactionCreate` overflows the 1232-byte tx at
  ~500 bytes of create data (a 19-account inner ix is already too big).
  `buildProposeIxs` auto-switches to the buffered chain above that
  budget.
- **`wrapBuffered`**: the vault message is staged on-chain in chunks
  (Squads `transactionBufferCreate`/`Extend`, hash-and-size-pinned at
  creation — chunking cannot weaken INV-9), then
  `vaultTransactionCreateFromBuffer` builds the vault transaction. The
  deployed program REQUIRES the args' `transaction_message` to be the
  exact six-zero-byte placeholder. `unwrap` reassembles buffered chains,
  so the decoder seam and the chain reader keep working.
- **The execute insert is irreducible** (`vaultTransactionExecute`
  carries every inner account as a meta). Keep inserts single-signer
  (payer == proposer) and pack oversized ones as v0 + address-lookup-table
  transactions — the table compresses the OUTER governance accounts; the
  data is untouched. Practical ceiling ≈ 25 execute account metas; larger
  actions wait for the Stage 3 coordinator.
- **Stacked executes need an explicit CU budget**: governance execute →
  Squads execute → 2 inner CPIs exceeded the 200k default; production
  senders set 400k (the mainnet runs already did).
- Program fixtures are committed gzipped (zero-padded 10 MB programdata
  compresses ~10x); the test harness inflates them before bankrun loads.

## D-020 — GATE 0b determined: transfer-fee Token-2022 dropped from scope (2026-06-11)

On the real binaries (bankrun): a create_v2 token is Token-2022 and
trades round-trip on the curve (creator fees accrue to a PDA creator's
vault — the GATE 0a result, now hermetic in CI). pump initializes the
mint INSIDE create_v2 (no TransferFeeConfig among its extensions) and
refuses a pre-existing mint account, so transfer-fee mints can never
reach the curve. Per the gate's fail branch the feature is dropped; the
D-004 open question is closed. Operationally, D-009 generalizes: every
account receiving fee crumbs (fee recipients, creator vault) must be
prefunded to the rent floor or the runtime rejects the trade.

## D-021 — PumpSwap pool ixs resolved; graduation is permissionless and provable hermetically (2026-06-11)

The post-graduation (verify) item is closed against the deployed binaries:

- `@pump-fun/pump-swap-sdk` 1.17.0 (pinned; already a transitive dep of
  pump-sdk) ships a fully OFFLINE `PumpAmmSdk` — decoders + instruction
  builders that take pre-fetched chain state, same shape as the pump rail.
- **Graduation needs no authority**: pump `migrate_v2`'s only signer is
  `user`; `withdrawAuthority` is a `relations: [global]` account (must
  match global state, never signs). A whale buy-out (curve `complete`)
  plus anyone's `migrateV2Instruction` produces the canonical PumpSwap
  pool in bankrun. New fixtures: `amm-global-config`, `amm-fee-config`,
  `amm-global-volume-accumulator` (dump script now tops up missing
  labels).
- **Creator-fee continuity (INV-1) survives graduation**: the migrated
  pool's `coinCreator` == the bonding-curve creator == the DAO vault,
  verified on chain state in tests/action-amm.integration.test.ts. On the
  AMM venue creator fees accrue in WSOL to `coinCreatorVaultAta(vault)`.
- sdk bug found running the real binary: `extendAccount` (auto-prepended
  by the sdk when a pool predates POOL_ACCOUNT_NEW_SIZE) marks `user`
  READ-ONLY — on mainnet the fee payer is implicitly writable, but under
  governance CPI the stored proposal metas are the only privilege source
  and the program charges `user` the realloc rent. The action builders
  promote that meta (`promoteExtendAccountUser`).

## D-022 — AMM-venue actions are STAGED: direct treasury legs after the custody chain (2026-06-11)

The hard wall: a PumpSwap buy carries 26 accounts, so its Squads
`vaultTransactionExecute` needs ~30 account metas and the governance
insert's DATA alone (~1080 bytes of raw metas) busts the 1232-byte
transaction limit — past D-019's ~25-meta execute ceiling, and no packing
trick compresses instruction data. Adding a second Squads member with
Execute permission would break the spec's load-bearing sole-member
custody (INV-7, "exactly ONE member"), so it was rejected.

Resolution — one proposal, two kinds of legs, all hash-pinned and
hold-up-gated:

- **vault legs** (`buildProposeIxs.innerIxs`): vault-signed, through the
  unchanged Squads custody chain — stage the spend (SOL and/or tokens)
  from the vault to the governance native treasury.
- **direct legs** (`buildProposeIxs.directIxs`, new): inserted as
  ProposalTransactions AFTER the chain, one each; at execution the
  governance program itself invoke_signs for the NATIVE TREASURY — the
  multisig's sole member, a no-human-key PDA that already roots the
  custody chain, so INV-7 is intact. The treasury acts on the AMM and the
  proceeds RETURN TO THE VAULT inside the same proposal (exact-out
  amounts: the buy is exact-base-out, the deposit exact-lp-out, so the
  return transfers are deterministic at build time).
- INV-9 convention: `unwrap()` treats instructions after the
  `vaultTransactionExecute` as direct legs and appends them to the
  recovered inner set; `descriptionLink` hashes inner + direct in
  execution order. The chain reader needs no change.
- Slippage margins (unspent maxQuote remainder, base dust) stay with the
  native treasury — it is the D-016 execution-rent sink, so this is
  self-funding, and any residue remains DAO-custodied.
- Execute-side: account-heavy direct executes fall back to v0+ALT like
  the inserts (harness `sendWithAlt` now takes instruction arrays).

Proven end-to-end on the real binaries
(tests/action-amm.integration.test.ts): graduation → staged AMM buyback
(bought tokens land in the VAULT's ATA; the buy's WSOL creator fee lands
in the DAO's own creator vault ATA) → staged provideLiquidity (LP tokens
land in the VAULT's LP ATA), both via vote + 72h hold-up.

## D-023 — Keeper sweeps the AMM venue by CONSOLIDATION; the DAO never custodies WSOL (2026-06-11)

Post-graduation, creator fees accrue as WSOL in the AMM creator-vault ATA
(`coinCreatorVaultAtaPda`). Two permissionless ways to move them existed:

- `collect_coin_creator_fee` (AMM program, zero signers) pays the WSOL to
  the coinCreator's own WSOL ATA. REJECTED as the keeper path: the vault
  would custody WSOL it can only unwrap by proposal (the close needs the
  vault's signature), and the keeper's INV-8 gross accounting is
  native-SOL denominated.
- `transfer_creator_fees_to_pump_v2` (AMM program, only signer = payer)
  moves the AMM WSOL into the CURVE creator vault as native SOL. CHOSEN:
  one ordinary curve collect then sweeps both venues, all native SOL.

Findings on the way:

- The pump-sdk's `transferCreatorFeesToPumpV2` wrapper hardcodes
  `coinCreator = feeSharingConfigPda(mint)` (it serves the fee-sharing
  flow). For a plain PDA creator we encode the instruction through the
  sdk's own offline anchor programs with `coinCreator = vault`; a unit
  test pins byte-identity against the sdk wrapper for the sharing-config
  creator, so drift in the sdk's encoding is caught.
- The rail's `buildCollectFeesIxs(creator, feePayer)` is now
  venue-composing: `[consolidate?, curve collect]`, the consolidation leg
  included only when the AMM ATA holds a positive amount. It throws if
  AMM fees exist but no feePayer was given (the creator must never sign —
  INV-2). The previous implementation went through
  `collectCoinCreatorFeeV2Instructions`, which would have stranded the
  AMM portion as treasury WSOL.
- Keeper accrual (`getAccruedFees`) = curve lamports above the D-009 rent
  floor + AMM ATA WSOL amount (1:1 lamports). The consolidation also
  releases the source ATA rent into the curve vault, so a sweep can credit
  slightly MORE than the measured accrual — the integration assertion is
  `gross >= curve + amm`, with components pinned exactly (AMM ATA drained
  to 0, curve vault back at its floor).
- Scope note: pump curve coins are SOL-quoted, so the graduated pool's
  quote is always WSOL; the spec's USDC-ATA mention (6.5) has no
  reachable instance on this rail in MVP.

Proven end-to-end on the real binaries
(tests/action-amm.integration.test.ts phase 4): pre-graduation curve fees
and post-graduation AMM fees both live, ONE keeper-signed tx through the
real `sweepVault` core (INV-2 checked against the real ix set), vault
credited native SOL, second sweep a no-op.

## D-024 — Merkle distributor ID resolved: the IMMUTABLE Jito deployment; distribute ships on it (2026-06-11)

Resolution of the spec's "(verify deployed ID)" for `distribute` (6.8):

- The deployed program is `mERKcfxMC5SqJn4Ld4BUris3WKZZ1ojjWJ3A3J5CKxv` —
  the JTO airdrop distributor (jito-foundation/distributor, Saber
  merkle-distributor lineage). Verified directly on mainnet: executable,
  and its **upgrade authority is removed** (ProgramData authority = None),
  so the binary our tests pin can never change underneath the fund path.
- The repo's `declare_id` (`m1uq...`) does NOT exist on mainnet — never
  trust a repo's Anchor.toml for a deployed address.
- The program publishes its anchor IDL on chain (merkle_distributor
  0.0.1); vendored at `packages/sdk/src/idl/merkle-distributor.json` and
  instructions are built manually against it (the D-010 VSR pattern).
  The binary itself is a gzipped fixture (`merkle_distributor.so.gz`).

Mechanics verified on the real binary (tests/action-distribute.integration.test.ts):

- Tree hashing (TS port, sdk/src/merkle-distributor.ts): leaf =
  sha256([0] || sha256(claimant || u64le(unlocked) || u64le(locked))),
  branches sha256([1] || sorted pair) — OpenZeppelin-style commutative
  fold. The REAL verifier accepting our proofs is the compatibility proof.
  Leaves are sorted so a share set has ONE canonical root (order-
  independent, INV-9-friendly).
- One proposal (vault legs only, ~12 metas — no D-022 staging needed):
  newDistributor (vault = admin + rent payer, root pinned at proposal
  time), fund tokenVault with exactly Σ(shares), syncNative. The program
  requires all timestamps to be in the FUTURE at EXECUTION — builders/
  callers must budget the voting window + hold-up into
  startVesting/endVesting/clawbackStart.
- Distribution token is WSOL (spec: totalLamports). The DAO's own token
  is Token-2022, which this 2023 program predates — NOT distributable
  here. Claimants receive WSOL into their ATAs.
- clawbackReceiver = the VAULT's WSOL ATA (pre-created outside the
  proposal): after clawbackStartTs (>= endVesting + 86400, program-
  enforced) ANYONE returns the unclaimed remainder to DAO custody, once.
  Claims after the clawback are refused. Books close exactly:
  Σ(claimed) + clawed-back == funded.
- The (mint, version) PDA namespace is GLOBAL and permissionless. A
  squatter front-running our (WSOL, version) pair only makes
  newDistributor fail at execute — the chained execute aborts and the
  funding never leaves the vault; re-propose with a fresh random version.
- Double-claim impossible (ClaimStatus PDA init), tampered amounts fail
  the proof — both asserted against the real binary.

## D-025 — setParam ships on a whitelisted-param registry; ratchet by omission (2026-06-12)

Spec 6.8 `setParam` ("whitelisted params only, within tier floors and
ratchet direction") resolved and shipped, completing the action menu:

- **Whitelist** (`SET_PARAM_WHITELIST`): `quorumPercent`,
  `holdUpSeconds`, `proposalThresholdTokens`, `baseVotingTime`. Floors:
  quorum within [tier floor, 100]; proposal threshold >= the tier's bps
  of supply; hold-up >= the MODE-resolved floor (council = tier floor,
  cypherpunk = max(24h, floor), sovereign = 0 — the exemption it chose,
  double-confirmed, at launch); baseVotingTime >= 3600s (program min,
  D-014). Exported `holdUpFloorSeconds(mode, tier)` from matrix.ts so
  resolveGovernanceParams and setParam share one floor function.
- **Ratchet direction is enforced by OMISSION** (the INV-11 reading):
  `buildSetParamIxs` starts from the CURRENT on-chain GovernanceConfig
  and changes ONLY the target field — the veto thresholds (mode surface:
  a cypherpunk DAO cannot acquire a council veto, a council DAO cannot
  drop its veto), vote tipping (the exit window), cool-off, and the
  deposit exemption are not reachable through the menu at all.
  Mode TRANSITIONS stay where the spec puts them: governance-level in
  MVP (12.2 caveat), structural at Stage 3.
- **Verify item resolved on the real binary**: `SetGovernanceConfig`'s
  only account is the governance PDA as writable SIGNER, and the
  deployed program's ExecuteTransaction invoke_signs for the governance
  account itself. setParam therefore rides a DIRECT leg (D-022
  `directIxs`) with no Squads wrapping; the vault is never touched.
  `buildProposeIxs` now accepts direct-leg-only proposals (empty inner
  set + non-empty directIxs).
- Proven end-to-end (tests/action-setparam.integration.test.ts): a
  cypherpunk DAO raised its own hold-up 72h -> 96h by vote; non-target
  config byte-identical after; and the new floor BINDS — the program
  refuses an insert carrying the stale 72h hold-up and refuses execution
  at +72h, then executes at +96h (INV-3 under the voted config).

## D-026 — Holder snapshots: RPC gPA with a loud top-20 fallback; DAS optional (2026-06-12)

The `distribute` input service (spec 6.8: "backend snapshots holders at
slot (RPC/DAS), builds tree") ships as sdk math + backend sources:

- **Pure math in the sdk** (`proRataShares`): floor-division pro-rata,
  Σ shares <= total (dust stays in the vault), owners aggregated across
  token accounts (ClaimStatus is per-claimant), exclusion list for the
  DAO's own accounts, zero shares dropped, deterministic order. All
  bigint (INV-6).
- **RpcHolderSnapshot**: getProgramAccounts on the token program,
  memcmp(mint @ 0), 72-byte dataSlice (Token-2022 accounts vary in size
  — no dataSize filter), `withContext` pins the slot. **Verified live:
  the PUBLIC mainnet RPC excludes the token programs from secondary
  indexes (-32010) and per-method rate-limits the call**, so the source
  falls back to getTokenLargestAccounts + owner reads — exact for <= 19
  token accounts and REFUSING at the top-20 cap (a possibly-truncated
  holder set must never silently feed a distribution).
- **DasHolderSnapshot** (Helius getTokenAccounts, cursor-paginated) is
  the indexed path for real holder counts — optional and feature-flagged
  per the env spec; JSON-number amounts beyond 2^53 are refused rather
  than rounded (INV-6). `makeHolderSnapshotSource` picks DAS when a key
  is configured, RPC otherwise (zero-signup default keeps working).
- **Trust note (12.3)**: the snapshot is an off-chain INPUT. What the
  DAO votes on is the merkle root pinned in the proposal (INV-9); voters
  verify the published share list against the root, not the backend.
- Wire-up: `POST /snapshots` (501 until a source is configured),
  `scripts/snapshot-holders.ts` for live reads.

## D-027 — Stage 2 suites; the INV-9 hash is now computed from the round-tripped effective set (2026-06-12)

Stage 2 (Section 13 item 9) shipped: property + fuzz + CU suites,
observability, dependency audit, REDTEAM.md. Evidence in GATES.md GATE 2.
One finding changed fund-path code:

- **Privilege-normalization hash bug (found by the fuzz suite).** The
  Squads transaction message stores ONE privilege level per account —
  signer/writable = the max across the whole inner set (the Solana
  runtime's own per-transaction semantics). `unwrap()` therefore recovers
  NORMALIZED flags. `buildProposeIxs` used to hash the RAW inner ixs, so
  any inner set reusing an account with conflicting flags would publish
  an artifact hash that could NEVER match the chain-side recomputation —
  a permanent false-positive red badge (noise that trains users to
  ignore the real INV-9 signal). Fix: the published hash is computed
  from `unwrap(wrap(innerIxs))` + directIxs — publish-time and
  chain-side hashes are equal BY CONSTRUCTION. Regression pinned in
  fuzz-bounds.test.ts; all existing suites unaffected (non-conflicting
  sets round-trip exactly).
- **Property formulation note**: the naive "attacker is always locked
  through the drain" is FALSE for extreme voting windows (fast-check
  found the counterexample: a ~22-day window lets the minimum lockup
  expire during voting). The true, machine-checked theorem is the
  dichotomy: locked-through-drain OR drain >= saturation×quorum% of
  public notice; at the shipped 3-day window the first arm always holds.
- **CU numbers** (real binaries, 400k limit): worst executed governance
  tx = 147,519 CU (distribute's newDistributor+fund+sync vault leg) —
  36.9% of the limit; spec ceiling is 85%.
- **Sec3 X-Ray**: not applicable in MVP — there is no custom on-chain
  code to scan; recorded in GATES.md rather than silently skipped. The
  obligation re-arms at Stage 3. `pnpm audit --prod` run instead for the
  TS surface; bn.js bumped 5.2.2 -> 5.2.3 (infinite-loop advisory);
  bigint-buffer (no patch exists; native path not loaded; fixed-width
  inputs) and postcss/uuid (build-time / non-fund paths) dispositioned
  in REDTEAM.md §5.4.
- **Observability conventions**: KeeperMonitor escalates exactly at the
  consecutive-failure threshold crossing (one alert per outage, reset on
  recovery — including idle "nothing to sweep" ticks); all lamport
  counters are bigint end-to-end. Proposal anomalies are computed
  server-side by detectProposalAnomalies and shipped on
  GET /chain/proposals/:id (`anomalies: [...]`) — a deliberate route
  contract change.

## D-028 — Browser signing ships as a server-built-transaction seam over wallet-standard (2026-06-12)

The D-017 deferral ("browser signing is Stage 2") is closed. Design:
the browser NEVER carries chain deps — the bundle-size discipline that
keeps the launch form at ~105 kB extends to wallet actions.

- **Backend builds, wallet signs, backend submits.** New
  `packages/backend/src/tx-builder.ts`: pure unsigned-tx builders
  (deposit governing tokens, cast vote approve/deny) oracle-pinned
  against the spl-governance client; `RpcGovernanceTxSource` resolves
  chain context (the browser sends only proposal + wallet + approve —
  realm/governance/mint/proposer record are read from the proposal
  account, never trusted from the client). Routes:
  `POST /chain/txs/{deposit,cast-vote,submit}` (501 until configured).
- **Every built tx has the WALLET as fee payer and only required
  signer** — asserted in tests; there is no way to smuggle a platform
  key into the signer set, and the user pays their own fees.
- **Client side talks wallet-standard directly** (~100 lines,
  app/lib/wallet-standard.ts): the injected-wallet registration
  handshake plus "standard:connect" / "solana:signTransaction" — the
  features operate on RAW BYTES, which is exactly why no web3.js is
  needed in the page. Phantom/Solflare/Backpack all register through
  this protocol. The flow state machine (build -> sign -> submit) is
  pure with injected fetch + signer.
- **Proven on the real binary**
  (tests/wallet-vote.integration.test.ts): a holder's deposit and
  approve-vote transactions — built by the backend builders,
  deserialized from base64, signed by the holder alone, re-serialized,
  submitted as raw bytes — are accepted by the deployed spl-governance
  program; the recorded yes weight equals the deposit exactly and the
  proposal finalizes Succeeded on that vote.
- **E2E**: a fake wallet-standard wallet registered via the real
  handshake; the stub server issues its signature ONLY if the submitted
  payload is the unsigned tx it built, signed by the wallet — the bytes
  round-trip app -> wallet -> app is what the test pins. A no-wallet
  environment gets a clear error, not a crash.
- Scope note: vote + deposit are the holder actions; `execute` stays
  permissionless (keeper/anyone) and proposal AUTHORING stays
  backend/sdk-side for now — both can ride the same seam later.
- Ops note: workspace packages resolve through `dist/` — backend/sdk
  must be rebuilt before the e2e stub server picks up new routes (the
  stale-dist failure mode hit twice this session).

## D-029 — Stage 3 build pipeline proven; toolchain + key-handling conventions (2026-06-12)

The Stage 3 program path (spec 6.9) is unblocked with evidence, ahead of
writing the real gate/coordinator logic:

- **Toolchain**: solana-cli 4.0.1 / cargo-build-sbf 4.0.0 (Anza stable
  installer), platform-tools v1.53, anchor-lang 0.30.1 (the spec's pin).
  Environment quirk: cargo-build-sbf's built-in downloader fails on the
  egress proxy's CA (`invalid peer certificate`) — fetch
  platform-tools-linux-x86_64.tar.bz2 with curl and extract into
  `~/.cache/solana/v1.53/platform-tools/` instead.
- **programs/ workspace** with `overflow-checks = true` at the workspace
  profile level (the 6.9 safety baseline — applies to every member).
  proposal-gate is a SCAFFOLD: one `initialize` creating the gate config
  PDA, enough to pin the pipeline; the menu-validation and ratchet logic
  land tests-first against the component contract.
- **Proof** (tests/stage3-build.integration.test.ts): the compiled
  artifact loads in the SAME bankrun harness as the deployed binaries;
  the account comes out with the exact anchor discriminator/layout/bump
  and re-initialization is refused. Our-program fixtures follow the
  mainnet-dump convention: committed gzipped
  (tests/fixtures/proposal_gate.so.gz) so CI needs no Rust toolchain;
  rebuild command in the test header.
- **Key handling**: `programs/target/` is gitignored — cargo build-sbf
  drops a program-id KEYPAIR in target/deploy and it must never be
  committed. The scaffold's declare_id came from a throwaway key;
  the real program ID is regenerated at first devnet deploy (operator
  upgrade-authority rules from Section 11 apply from that moment).

## D-030 — proposal-gate v1: on-chain validation engine + structural ratchet (2026-06-12)

The first REAL Stage 3 logic, tests-first on real chain state
(tests/stage3-gate.integration.test.ts; binaries: deployed
spl-governance + Squads + OUR cargo-build-sbf artifact):

- **Gate config** (PDA per realm, immutable after init — loosening the
  whitelist is exactly what the gate exists to prevent): realm,
  governance, mode level, program whitelist (max 16).
- **`validate_transaction`** (permissionless crank): parses a
  ProposalTransactionV2 account (owner + account-type tag checked, then
  a fully bounds-checked byte reader — no borsh dependency on
  spl-governance needed), requires every OUTER instruction's program on
  the whitelist, and for Squads `vaultTransactionCreate` legs parses the
  embedded TransactionMessage (3 header bytes, smallVec keys, compiled
  instructions, ALT count) and requires every INNER program whitelisted
  too — proven by refusing a proposal that smuggled a foreign program
  inside the vault-signed message while clearing the plain custody
  chain. Success mints a `Clearance` PDA keyed by the transaction.
  REFUSED by design in v1: buffered Squads messages (span multiple
  accounts — guarded proposals must use the plain wrap) and address
  table lookups (would hide keys).
- **`ratchet`** (INV-11 structural core): mode moves ONLY toward
  decentralization (guarded 0 -> council 1 -> cypherpunk 2 ->
  sovereign 3) and the required signer is the GOVERNANCE PDA — which
  only ever signs through executed proposals, so a ratchet is always a
  voted decision. Proven in one proposal: leg 1 (0 -> 2) executes, leg 2
  (2 -> 1) is refused by the program after every governance timer
  passed.
- **Honest v1 limits** (the road to GATE 3's "byte-enforced menu"):
  program-level whitelist, not yet per-instruction byte-validation
  (e.g. a SetGovernanceConfig direct leg within the whitelist is not yet
  floor-checked on-chain); clearances are not yet consumed by anything —
  the next increment wires the gate PDA as the governance's REQUIRED
  SIGNATORY so an uncleared proposal can never reach voting
  (spl-gov v3.1 AddRequiredSignatory, to verify on the binary).
- Squads discriminators pinned from @sqds/multisig 2.1.4
  (vaultTransactionCreate [48,250,78,168,208,226,218,211];
  transactionBufferCreate [245,201,113,108,37,63,29,89]); governance
  account tag ProposalTransactionV2 = 13 (lib 0.3.28). anchor 0.30
  does not re-export `pubkey!` — trusted ids are byte-array consts.

## D-031 — Required-signatory mechanics pinned from program source (gate sign-off prerequisite) (2026-06-12)

The next gate increment (clearance => sign-off; uncleared proposals never
reach voting) rides spl-governance v3.1 REQUIRED SIGNATORIES. The
installed client lib (0.3.28) PREDATES the feature entirely — no
`withAddRequiredSignatory` exists — so the instructions must be built
manually (the D-010 VSR pattern). Pinned from the program source
(solana-labs/solana-program-library governance/program, master; the enum
is append-only and the deployed binary self-reports VERSION 3.1.4):

- `GovernanceInstruction` borsh enum order (variant index = position):
  0 CreateRealm, 1 DepositGoverningTokens, 2 WithdrawGoverningTokens,
  3 SetGovernanceDelegate, 4 CreateGovernance, 5 Legacy4,
  6 CreateProposal, 7 AddSignatory, 8 Legacy1, 9 InsertTransaction,
  10 RemoveTransaction, 11 CancelProposal, 12 SignOffProposal,
  13 CastVote, 14 FinalizeVote, 15 RelinquishVote, 16 ExecuteTransaction,
  17 Legacy2, 18 Legacy3, 19 SetGovernanceConfig, 20 Legacy5,
  21 SetRealmAuthority, 22 SetRealmConfig, 23 CreateTokenOwnerRecord,
  24 UpdateProgramMetadata, 25 CreateNativeTreasury,
  26 RevokeGoverningTokens, 27 RefundProposalDeposit,
  28 CompleteProposal, **29 AddRequiredSignatory { signatory: Pubkey }**,
  **30 RemoveRequiredSignatory**, 31 SetTokenOwnerRecordLock,
  32 RelinquishTokenOwnerRecordLocks, 33 SetRealmConfigItem.
- `AddRequiredSignatory` accounts: [governance (writable, SIGNER) — i.e.
  only via an executed proposal (a direct leg, like setParam/ratchet),
  required_signatory (writable), payer (signer), system]. PDA seeds:
  ["required-signatory", governance, signatory].
- `AddSignatory` (v3.1 layout — DIFFERENT from the 0.3.28 wrapper!):
  [governance, proposal (w), signatory_record (w), payer (s), system,
  then EITHER (tokenOwnerRecord + governanceAuthority signer) OR
  (the governance's RequiredSignatory account — the PERMISSIONLESS
  path the gate cranker uses)]. SignatoryRecord PDA seeds:
  ["governance", proposal, signatory].
- `SignOffProposal` is enum variant 12, no args — what the gate program
  will CPI with its signatory PDA as the signer, once per proposal,
  after every transaction's Clearance exists.

Planned wiring (next increment, tests first): gate signatory PDA =
["signatory", realm]; launch ceremony (or a vote) executes
AddRequiredSignatory(gate signatory) as a direct leg; per proposal the
cranker calls AddSignatory (permissionless path), validates every
ProposalTransaction (D-030 clearances), then gate `sign_off` checks
clearances for transaction indices 0..n (n+1th PT account passed and
required EMPTY — proves completeness without parsing ProposalV2) and
CPIs SignOffProposal. ALL of this is source-pinned, NOT yet
binary-verified — the bankrun suite must confirm the indices/layouts
empirically before any of it is trusted (the 0.3.28 AddSignatory
account-order mismatch is exactly the kind of drift that bites).

**SUPERSEDED by D-032 (2026-06-12):** this plan was source-pinned from
the public solana-program-library master, which has DIVERGED from the
deployed GovER5 fork. Binary verification proved the deployed program
has NO required-signatory mechanism at all (variant 29 != any such
instruction; no processor; no strings). The required-signatory wiring
above is ABANDONED. See D-032 for the finding and the realm-authority
redesign path. The enum indices listed here are the PUBLIC MASTER's,
NOT the deployed binary's — do not build against them.

## D-032 — STOP/FINDING: the deployed governance binary is a FORK with NO required signatories; Guarded-mode sign-off must be redesigned (2026-06-12)

The D-031 plan (gate sign-off via spl-governance REQUIRED SIGNATORIES)
hit a hard stop when verified against the binary. `AddRequiredSignatory`
with variant byte 29 returned "invalid instruction data" / "Unexpected
variant tag", so I inventoried the actual deployed program
(tests/fixtures/spl_governance.so — the live GovER5 dump, self-reports
VERSION 3.1.4, the same binary GATE 1 ran against on mainnet):

- **No required-signatory mechanism exists.** The processor file list in
  the binary's string table has NO `process_add_required_signatory.rs`
  and NO `process_remove_required_signatory.rs`; there are zero
  `RequiredSignatory` / `required-signatory` strings anywhere in the
  .so. The public solana-program-library `governance` master (which I
  source-pinned D-031 from) has DIVERGED from the live GovER5
  deployment.
- **What the deployed fork DOES have** (full processor inventory):
  create_proposal, add_signatory (plain), sign_off_proposal,
  cast_vote, finalize_vote, relinquish_vote, insert_transaction,
  remove_transaction, execute_transaction, cancel_proposal,
  complete_proposal, flag_transaction_error, set_governance_config,
  set_governance_delegate, set_realm_authority, set_realm_config,
  create_token_owner_record, create_native_treasury,
  deposit/withdraw_governing_tokens, revoke_governing_tokens,
  update_program_metadata — PLUS a versioned-transaction suite the
  mainline lacked at this point (CreateTransactionBuffer,
  ExtendTransactionBuffer, CloseTransactionBuffer,
  Insert/Execute/Remove VersionedTransaction[FromBuffer]) and
  Deprecated CreateProgram/Mint/TokenGovernance variants. The borsh
  enum ordering therefore does NOT match the public master — any
  manually-built governance instruction beyond what the 0.3.28 client
  emits MUST be byte-verified against THIS binary first (D-031's caveat,
  now proven necessary).
- **Consequence for Guarded mode (spec 6.9 / INV-11 structural):** the
  "gate PDA as the governance's required signatory => every proposal
  blocked until cleared" design is IMPOSSIBLE on the deployed program.
  Plain `add_signatory` exists but is per-proposal and voluntary — it
  cannot FORCE every proposal to carry the gate signatory, so it gives
  no structural guarantee.
- **Redesign path (operator decision — NOT improvised here):** Guarded
  enforcement must move to a mechanism the fork actually supports. The
  leading candidate: the gate program holds the REALM AUTHORITY and the
  sole proposal-creation weight — in Guarded mode the
  min-tokens-to-create-proposal is set (via set_governance_config, which
  the gate signs as realm/governance authority) so that only the gate's
  own TokenOwnerRecord can author proposals, and the gate's
  create_proposal CPI runs the D-030 validation engine BEFORE creating.
  This keeps the validation engine + clearance machinery (D-030) intact;
  only the enforcement seam changes. Alternative: ship Guarded as a
  custom full-governance fork (heavy; rejected unless the authority
  path fails verification too).
- **Unblocked, still valid:** proposal-gate v1 (D-030 — validation
  engine + structural ratchet) stands; the ratchet uses only the
  governance-as-signer pattern, which the fork supports. The spike test
  was removed (it asserted the absent mechanism); nothing shipped on the
  phantom instruction.

NEXT (tests-first, after operator confirms the redesign direction):
binary-verify that the gate can hold realm authority and gate
proposal-creation weight via set_governance_config on THIS fork, then
wire create_proposal validation. Until then, Guarded mode stays Stage 3
WIP and the MVP ships Council + Cypherpunk only (unchanged from the spec
scope).

## D-033 — Native launchpad: scope, economics, and the four locked choices (2026-08-08)

The product grows a second, standalone half: our OWN bonding curve, a
public coin board, and graduation into Raydium — the DAO stack becomes an
opt-in on top rather than the only way in. Authoritative spec:
**SPEC-LAUNCHPAD.md v1.0** (SPEC.md gains a §14 pointer only; v2.0 stays
operator-signed and unchurned).

Operator decisions, taken 2026-08-08, not to be re-litigated:

1. **Standalone + DAO opt-in.** One-click pump-style launches by default;
   a "launch as DAO" toggle runs the existing ceremony with our curve
   swapped in for pump's `create_v2` — the coin's `creator` becomes the
   advance-derived Squads vault PDA, so INV-1/INV-7 hold unchanged.
2. **Devnet first.** Hermetic proof against real dumped binaries, then a
   live devnet run; mainnet only behind an operator go/no-go (GATE L3).
3. **pump-classic economics**, every number in an operator-settable config
   PDA: 1B supply / 6 decimals, virtual 30 SOL + 1.073e15 tokens, 793.1e12
   sellable, 206.9M reserved for the pool.
4. **LP burned at graduation.** Strongest trust story and the smallest
   surface: no dependency on Raydium's closed-source Burn & Earn program.

Derived choices recorded here so Phase 2 does not re-open them:

- **Fees 1% total, 70 bps protocol / 30 bps creator**, bounded in-program
  to [10, 500] bps. The creator share is what gives the DAO toggle teeth:
  the Squads vault earns 0.30% of every curve trade in perpetuity.
  `collect_creator_fee` is **permissionless-to-recipient** — anyone may
  crank it, funds can only move to the stored creator. This deliberately
  fixes the pump.fun design that made GATE 0c fail: pump requires the
  creator to SIGN collection, which a PDA creator cannot do.
- **Fee bps are snapshotted onto each curve at creation** (INV-FEE-SNAPSHOT).
  A later config change cannot retroactively tax live curves — the
  authority key must not be a rug vector.
- **No withdraw instruction exists, at any privilege level.** Curve
  principal leaves only via `buy`/`sell`/`migrate` under PDA signatures
  (INV-VAULT-PDA-ONLY). The May-2024 pump.fun drain was a privileged
  withdraw path, not a math bug; the fix is structural absence.
- **Migration is permissionless and idempotent**, gated on
  `complete && !migrated`. The keeper is a fee payer providing liveness,
  never an authority — same posture as the sweep keeper (INV-2).
- **CPMM addresses (program, amm_config, fee receiver) are immutable after
  `initialize_config`**, so a compromised authority cannot redirect
  migration liquidity. One binary serves every cluster; no cargo `devnet`
  feature.
- **`pool_state` is our own PDA** `["cpmm-pool", mint]` signed via
  `invoke_signed`, not the canonical Raydium pool PDA. The deployed
  program accepts any signing account (verified, D-034), so this is one
  deterministic unsquattable path instead of a squattable primary plus a
  fallback. Competing pools for the same mint cannot be prevented in any
  design; ours wins by holding the liquidity.
- **No structural anti-snipe in MVP** (pump-classic parity; pump has none).
  The creator's tool is the dev-buy bundled atomically into the create
  transaction. `Config.reserved` carries headroom so launch-window guards
  can land later without migrating live state. Dispositioned as accepted
  residual risk in REDTEAM.md.
- **Devnet economics are scaled** (`initial_virtual_sol = 1 SOL`, ÷30),
  because completing a full curve needs ~85 SOL and the faucet gives
  2–5 SOL per cycle. Scaled completion raise = 2,833,511,969 lamports
  (the division is not exact and the curve rounds in its own favour;
  planning notes carried the floor, 2,833,511,968 — the derived ceil is
  authoritative and is asserted in the property suite).
  Full pump-scale constants are proven hermetically instead, where
  airdrops are free. Same code path; only numbers differ — do not read
  devnet evidence as production economics.

## D-034 — Raydium CPMM verified against the DEPLOYED binary (2026-08-08)

The interface the graduation CPI targets, established the way D-031/D-032
taught us to: by driving the real binary, not by reading the source repo.
Evidence: `tests/launchpad-cpmm-verify.integration.test.ts` (5 tests, real
mainnet binary in bankrun).

- **Fixture provenance is pinned.** `tests/fixtures/cpmm.so.gz` was dumped
  at deploy slot **425,801,539** (2026-06-11T16:39:55Z), recorded in
  `tests/fixtures/fixture-slots.json`; the dump script now REFUSES a
  binary older than `RAYDIUM_CPMM_VERIFIED_SLOT`. The program is
  upgradeable (~quarterly), so "which deployment did we prove this
  against" is evidence, not trivia — the ops runbook diffs the live
  ProgramData slot against this number.
- **`initialize` confirmed**: discriminator
  `[175,175,109,31,13,152,155,237]`, args `(init_amount_0, init_amount_1,
  open_time)` as u64, the 20-account list in IDL order, and
  `["vault_and_lp_mint_auth_seed"] -> GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL`.
  AmmConfig index 0 decodes byte-for-byte at the researched offsets
  (`disable_create_pool@9 = 0`, `trade_fee_rate@12 = 2500`,
  `create_pool_fee@36 = 150,000,000`); the fee receiver is a wSOL token
  account, so `initialize` transfers lamports then syncs it native.
- **CORRECTION to the public description of LP accounting.** Raydium's
  `lock_lp_amount = 100` is **never minted**, not minted-and-locked: after
  `initialize`, `lp_mint.supply == sqrt(a0*a1) - 100` and the creator holds
  all of it. Consequence for INV-LP-BURNED: burning the migration
  authority's balance drives supply to **0**, not 100. Our first draft of
  the test asserted 100 and failed — which is the entire reason this leg
  exists before Phase 2.
- **Migration cost measured, not estimated**: 150,000,000 fee +
  42,156,720 rent (PoolState 637 B, ObservationState 4,075 B, lp_mint,
  2 vaults, creator LP ATA) = **192,156,720 lamports**, reconciled against
  the payer's balance delta (plus 2 signature fees). `create_pool_fee` is
  admin-settable, so migration reads it from AmmConfig at runtime rather
  than trusting this constant.
- **Pool-account rules confirmed**: the canonical PDA works with no
  signature; a non-canonical `pool_state` works IF it signs and is refused
  otherwise; mints supplied in the wrong sort order are refused. WSOL's
  first byte is 6, so ~97.7% of coin mints sort ABOVE it — the
  WSOL-as-token_1 branch is the rare one in the wild and Phase 2 must
  grind mints to exercise both.

## D-035 — Launchpad build pipeline + toolchain drift from D-029 (2026-08-08)

`programs/launchpad-curve` joins the Rust workspace (inheriting the 6.9
safety profile: overflow-checks on, lto fat, codegen-units 1) as a
scaffold whose only job is to pin the pipeline before fund logic exists —
the same sequencing D-029 used. Proven by
`tests/launchpad-build.integration.test.ts`: our compiled artifact loads
in the same bankrun harness as the deployed binaries, the config PDA comes
out with the exact anchor discriminator and byte layout the SDK will
decode, re-initialization is refused, and the fee band is enforced on both
bounds.

- **Toolchain drift, accepted and recorded**: this container's Anza stable
  installer gives **solana-cli 4.1.1 / cargo-build-sbf 4.1.0 /
  platform-tools v1.54**, where D-029 pinned 4.0.0 / v1.53. The D-029
  proxy workaround still applies verbatim, one version up: the built-in
  downloader fails on the egress proxy CA, so platform-tools must be
  curl-fetched into `~/.cache/solana/v1.54/platform-tools/`. Git
  dependencies additionally need `CARGO_NET_GIT_FETCH_WITH_CLI=true`.
- **The graduation CPI crate builds under our anchor pin** — the plan's
  headline risk, retired on day one. `raydium-cpmm-cpi` is pinned by REV
  `31338e2504e4a23172bdbbb49e05b10566594b14` (anchor-0.30.1 branch), never
  by branch: a moving pin is the one dependency that could silently change
  which program receives a curve's liquidity. It declares
  `anchor-lang = "=0.30.1"` / `anchor-spl = "=0.30.1"`, matching us
  exactly. Its structs are wire-compatible but semantically STALE
  (pre-creator-fee): never read `AmmConfig.creator_fee_rate` or the
  creator-fee `PoolState` fields through it. `create_pool_fee` at offset
  36 IS a declared field and is safe to read.
- **Metaplex**: `anchor-spl 0.30.1` with the `metadata` feature re-exports
  mpl-token-metadata 4.1.2 for the `create_coin` CPI. Do NOT add the
  standalone 5.x crate — the duplicate types do not unify (that pairing
  belongs to anchor-spl 0.31+).
- **Key handling unchanged from D-029**: `programs/target/` stays
  gitignored (cargo-build-sbf drops a private program-id keypair there);
  only the gzipped `.so` is committed. `declare_id!` currently holds a
  throwaway key — the real program id is minted at first devnet deploy,
  at which point Section 11 upgrade-authority rules apply.

## Open (verify) items — to resolve before/at their first use

- ~~spl-gov v3 Veto vote config~~ RESOLVED: D-011
- ~~SPL Governance proposal state-machine immutability after sign-off
  (INV-9)~~ RESOLVED at the evidence level: GATE 1 phase 2 re-read the
  wrapped ixs from chain post-execution and their hash matched the
  artifact published at proposal time
- ~~Merkle distributor deployed program ID (Stage 1, `distribute` action)~~
  RESOLVED: D-024 — the immutable Jito deployment (mERKc...); distribute
  shipped and proven end-to-end on the real binary
- ~~PumpSwap pool ixs for POST-GRADUATION buyback / provideLiquidity~~
  RESOLVED: D-021/D-022 — offline PumpAmmSdk + permissionless migration;
  both actions shipped (staged two-leg design) and proven end-to-end on
  the real binaries (tests/action-amm.integration.test.ts)
- ~~`transfer_creator_fees_to_pump_v2` consolidation (Stage 1, keeper)~~
  RESOLVED: D-023 — keeper consolidates AMM WSOL into the curve creator
  vault and sweeps both venues as native SOL; proven on the real binaries
- ~~Creator Fee Sharing at-launch config (GATE 0c; risk D-007)~~
  RESOLVED: D-019 — at-launch impossible (hard on-chain constraint);
  DAO-governed config post-launch verified on the real binaries
- ~~VSR registrar seed + manual ix layout on-chain validation~~ RESOLVED:
  D-018 — registrar seed order was WRONG in D-013's experiment and is now
  fixed (`[realm, "registrar", mint]`) and verified against the real
  binary; ix layouts validated end-to-end by the bankrun VSR leg
  (createVoter / createDepositEntry / deposit / updateVoterWeightRecord);
  Token-2022 registrar rejection re-confirmed on clean evidence

## D-036 — Graduation unblocked: sol-vault + hand-built CPMM CPI (2026-08-08)

`migrate` is proven end to end on the real Raydium binary (both mint
orderings). Two blockers, both found only by running it on real binaries:

- **"sum of account balances ... do not match".** The raise lived inside the
  program-owned `BondingCurve` account and moved by hand-edited lamports.
  Fixed by the spec'd SYSTEM-owned `["sol-vault", mint]` PDA (SPEC-LAUNCHPAD
  §2.1): buy pays in, sell/migrate pay out, every leg a signed
  `system_program::transfer` the runtime balances by construction. The
  `debit`/`credit` helpers are deleted. INV-SOL-CONSERVATION strengthened to
  assert the raise physically sits in the sol vault; the curve account never
  holds a lamport of it.
- **Raydium `RequireEqViolated` on `pool_state.is_signer`.** The
  `raydium-cpmm-cpi` crate declares `pool_state` as a non-signer, so its
  generated CPI can only seed Raydium's CANONICAL pool PDA. We seed OUR
  unsquattable `["cpmm-pool", mint]` PDA (decision A8), which the deployed
  program requires to sign. Fixed by hand-building the `initialize`
  instruction (`initialize_cpmm_pool`) with `pool_state` + `creator` as signer
  metas and `invoke_signed`. Account order/flags mirror the deployed
  Initialize context exactly (verified against the crate source).

## D-037 — Launchpad SDK/backend/keeper architecture (2026-08-08)

- **SDK is canonical, harness delegates.** `packages/sdk/src/launchpad/*` holds
  the browser-safe builders/PDAs/state-decoders/event-codec/error-map/cluster
  selection; `tests/helpers/launchpad-harness.ts` now DELEGATES to them, so the
  bankrun integration suites (real binaries) are the SDK's own proof — drift is
  structurally impossible. Cluster Raydium `authority` is DERIVED per cluster
  (devnet ≠ mainnet), closing the devnet-trap of passing mainnet's authority.
- **Indexer: polling behind an injected `TxSource`.** getSignaturesForAddress
  cursor + getParsedTransaction; decode emit_cpi INNER-INSTRUCTION bytes (logs
  are truncatable), tolerant of unknown discriminators (upgrade rule),
  idempotent by (signature, ix_index) so a rollback re-scan never double-counts
  (D-026 doctrine: no public-RPC websockets/gPA from datacenter IPs).
- **One service.** server.ts composes HTTP + indexer + keeper + SSE; the keeper
  is fee-payer-only and treats losing the migrate race as success. sqlite via
  node:sqlite; candles aggregated at read time.

## D-038 — Frontend send pipeline: the devnet broadcast trap (2026-08-08)

Research verdict (deploy-research): `signAndSendTransaction` broadcasts on the
WALLET's selected network; the wallet-standard `chain` param does NOT force
routing. The only dapp-deterministic devnet path is **signTransaction +
dapp-side `sendRawTransaction` to OUR RPC**. `app/lib/tx-sender.ts` makes that
the default on non-mainnet builds, with: an `account.chains` preflight
(necessary-not-sufficient), pre-simulation that decodes program errors before
the wallet sees them, and **landing verification** — polling OUR RPC for the
signature, so a tx that never appears before blockhash expiry becomes a
`wrong-cluster` error instead of a silent mainnet send. Expiry asks for a
rebuild, never a re-sign under a live blockhash.

## D-039 — Public deploy topology (2026-08-08)

Vercel (Next SSR frontend) + Railway (one always-on Node service: API +
indexer + keeper + SSE, sqlite on a volume) — the pump.fun/raydium pattern
(browser → api.* origin directly via `NEXT_PUBLIC_API_URL` + exact-origin CORS;
SSE direct, never through a Vercel rewrite). Browser RPC goes through our
server-side proxy (Helius key hidden, method-allowlisted, per-IP token bucket)
with `api.devnet.solana.com` as client fallback; a SECOND Helius key isolates
the indexer from browser-proxy abuse. Token metadata self-hosts on the Railway
volume (optional sharp 512×512 webp), served with ACAO:* + immutable cache;
`pump.fun/api/ipfs` is dead for third parties and is not used. Program id is
env-driven (minted at first devnet deploy; scaffold until then). Full deploy +
ops steps in RUNBOOK.md.

## D-040 — web3.js legacy simulateTransaction overload; e2e harness doctrine (2026-08-08)

The launchpad e2e suite (app/e2e/{board,coin,create}.spec.ts) caught a real
production bug the unit tests could not: `Connection.simulateTransaction(tx,
{sigVerify:false})` throws **"Invalid arguments"** for every legacy
`Transaction` — in web3.js (verified in the installed 1.98.4 source) the
config-object second argument exists ONLY for `VersionedTransaction`; the
legacy overload takes a signers ARRAY, and any non-array throws. The tx-sender
unit tests use a fake `SendRpc` seam, so the mismatch never surfaced; GATE L2
drove trades through the SDK scripts, not the browser. Every browser trade on
the deployed frontend failed at the `building` phase until this fix.

**Fix:** call `simulateTransaction(tx)` with the transaction alone — the
legacy path simulates the unsigned tx with sigVerify off by default, the same
intent — and the `SendRpc` interface now documents the constraint.

**Doctrine (extends "verify against the deployed binary"):** verify against
the installed LIBRARY too — a seam interface must be proven against the real
implementation it abstracts, at least once, in an end-to-end test. The e2e
harness (app/e2e/launchpad-harness.ts) is the pattern: the app's RPC points at
a same-origin `/__rpc` path Playwright intercepts (no CORS, un-stubbed calls
404 loudly), account bytes are fabricated with the SAME layouts the SDK
decoders read, a faithful wallet-standard fake exposes the sign-only feature,
and the buy/create specs run the REAL pipeline — real web3 Connection, real
serialization, real mint co-signing — end to end in the browser.

## D-041 — In-terminal swaps on the graduated Raydium pool (2026-08-08)

**Decision:** when a coin migrates, the /coin trade panel keeps working by
swapping on the CPMM pool directly from the browser — wrap SOL →
`swap_base_input` → unwrap — instead of dead-ending at "trading closed."
SDK grows a Raydium surface (`packages/sdk/src/launchpad/raydium.ts`):
packed-layout decoders (`decodeCpmmPool` — zero_copy(unsafe) ⇒ NO struct
padding, 637 bytes exactly; `decodeCpmmAmmConfig` — borsh, 236 bytes), quote
math (`cpmmSwapBaseInputQuote`: trade fee CEILs off the input, constant-
product output FLOORs — both favor the pool), fee-adjusted reserves
(`cpmmPoolReserves`: vault balance MINUS accrued protocol+fund fees — quoting
raw vault balances overquotes and the program's own slippage check rejects
the swap), and a hand-built 13-account `swap_base_input` builder.

**Proof (house rule D-031/D-034 — the binary, not the repo):**
tests/launchpad-cpmm-swap.integration.test.ts graduates a coin end-to-end,
then swaps with `minimum_amount_out` set EQUAL to the SDK quote: one lamport
under and the deployed binary aborts, one over and the balance assertion
fails. The wSOL→coin→wSOL round trip runs in both mint orderings; the sell
leg only matches because reserves are fee-adjusted (first swap parks fees in
the vault); the +1-lamport probe is refused with ExceededSlippage and logs
`Left: <ours> Right: <ours+1>` — the deployed program computing exactly our
number. Decoder offsets are asserted against a PoolState the real
`initialize` wrote. Two ops facts pinned: pools open at open_time=now+1
(warp 2s before swapping in bankrun), and the app reads the CPMM program id
from the pool account's OWNER — no cluster table to drift.

**App:** lib/amm-actions.ts (fetch context in 2 RPC calls, quotes, wrap/
swap/unwrap assembly, slippage-capped ammBuy/ammSell through the D-038 send
pipeline). Panel AMM state is tri-state — undefined (loading) / null (pool
unfetchable → honest "trading closed here") / context (live quotes, stats
strip + position priced off pool reserves).

## D-042 — DECISION: Guarded mode commits to Option A ("gate the front door") — spike VERIFIED on the deployed fork (2026-08-08)

**How this was decided.** The operator delegated the pending D-032 call
("make the decisions and finish the job", session `…9Aaw`, 2026-08-08).
The recorded recommendation was followed: run the cheap verification
spike for Option A before committing to anything. The spike ran, passed
on every leg, and the decision falls out of the evidence.

**The spike** (tests/guarded-gate-spike.integration.test.ts, 4 tests
against the exact deployed GovER5 v3.1.4 binary in bankrun; a Keypair
stands in for the gate PDA — invoke_signed gives a PDA identical signer
semantics). Setup mirrors a Guarded launch: fixed-supply community mint
(authority nulled), council mint with EXACTLY ONE token held by the
gate (authority nulled), governance config with
`min_community_weight_to_create_proposal = u64::MAX` and
`min_council_weight_to_create_proposal = 1`.

1. **Full-supply whale refused.** create_proposal with a record holding
   the ENTIRE community supply fails with `GOVERNANCE-ERROR: Voter
   weight threshold disabled` (0x25d). FINDING: this fork implements
   u64::MAX as an EXPLICIT disabled sentinel — community proposal
   creation is switched off, not merely priced out of reach. Strictly
   stronger than the design needed.
2. **Delegate loophole closed.** The whale's governance delegate hits
   the same sentinel — the check binds the token owner record, not the
   signer.
3. **Identity is not a bypass.** A freshly created zero-weight council
   record is refused ("Owner doesn't have enough governing tokens to
   create Proposal"). Exclusivity = the gate's weight-1 record being
   the ONLY council weight in existence (supply 1, mint authority null
   — asserted from chain).
4. **The Guarded UX works end to end.** The gate's council record
   authors a proposal whose ELECTORATE is the community mint; sign-off
   → Voting; the community votes; finalize after the window →
   **Succeeded**. Creation is gated; voting is untouched.

**DECISION.** Option A is COMMITTED as Guarded mode's structural
enforcement: at launch the ceremony mints the sole council token to the
gate PDA's token owner record and writes the guarded GovernanceConfig
(community create = u64::MAX sentinel, council create = 1); the gate
program's create_proposal CPI runs the D-030 validation engine BEFORE
the proposal exists. Off-menu proposals are never created, so they can
never be voted on — the headline guarantee, on the battle-tested
deployed program. Option B (custom governance fork) is REJECTED as
unnecessary; Option C (defer) is not taken.

**Still to BUILD (Stage 3 WIP — the spike is the foundation, not the
feature):** the gate program's create_proposal CPI instruction (gate PDA
signs as governance authority of its council record), ceremony wiring in
buildCreateDaoIxs for mode "guarded", SDK/frontend surfaces, and the
D-030 clearance flow in front of creation. MVP scope is unchanged:
Council + Cypherpunk ship first.

**Also recorded under the same delegation:** the GATE 2 and GATE L2
operator sign-off lines in GATES.md (both blank-pending, all technical
legs long determined) are filled as APPROVED, 2026-08-08.

## D-043 — Guarded mode SHIPPED: gate v2 + guarded ceremony + one launch page (2026-08-09)

Executes PLAN-UNIFIED-LAUNCH under the operator's directive ("unblock
guarded — finish it and make it available with some good default
options"). Everything below is proven on the deployed binaries in
bankrun; nothing is inferred from public source.

**Gate v2 (programs/proposal-gate).** Four new instructions, each a
hand-built CPI to the deployed GovER5 v3.1.4 fork (client-0.3.28 wire
parity: variants 1/6/9/12; account orders dumped and pinned), signed by
the gate authority PDA `["gate-authority", realm]` via invoke_signed:
`bind_realm` (deposits the realm's SINGLE council token — only the
program can sign for its PDA), `create_gated_proposal` (ANY wallet
proposes; the gate's council record authors; the electorate is pinned to
the community mint now stored in the Gate account), `insert_gated_
transaction` (the D-030 whitelist engine runs over the exact borsh
structs that are then re-serialized into the CPI — validated bytes ARE
inserted bytes), `sign_off_gated_proposal` (owner path; safe to leave
permissionless because nothing off-menu can have been inserted).
Identity is not the protection — the menu is: proposing is open to
everyone, content is structurally constrained.

**Proof** (tests/guarded-gate-v2.integration.test.ts, 4 tests, real
binaries; the suite DRIVES the SDK's new gate module, so the run is
simultaneously the SDK's proof): PDA-signed deposit lands (TOR amount
1); a zero-token wallet authors through the gate; a whitelisted insert
passes while an off-menu insert is refused BEFORE any CPI (no
ProposalTransaction account exists afterwards); sign-off opens voting;
the community passes the proposal; direct community creation stays
refused at the u64::MAX sentinel. A second leg proves the PRODUCTION
CEREMONY: buildCreateDaoIxs("guarded") + the Squads treasury harness
stands up a guarded DAO whose gate is initialized with the default menu
and bound by CPI, refuses the whale, and governs a treasury-grant
proposal to Succeeded through the front door.

**Good defaults.** DEFAULT_GATE_WHITELIST = the entire 6.8 action
surface, 8 programs: system, SPL token, ATA, spl-governance (setParam),
Squads v4 (custody chain), pump + pumpAMM (buyback/LP), the immutable
merkle distributor (distribute). Guarded resolves with the council
hold-up floor and NO veto seat (matrix); community proposal creation is
the u64::MAX disabled sentinel; council create weight 1; deposit-exempt
10. validateLaunchForm accepts guarded with ZERO extra inputs — the
strongest mode is the simplest one.

**One launch page (R2).** /launch now carries all four protections as
radio cards on a single page — Guarded default with a "recommended"
badge, Sovereign in danger styling — with the mode-specific inputs
revealing inline and old /launch?mode= links honored. The home page is
an overview with ONE Launch CTA; the per-mode launch links are gone.

**Known limits (documented, not hidden):** the gate's single TOR caps
outstanding proposals at the fork's per-record limit (~10 live at once;
finalization frees slots); buffered Squads messages and ALTs remain
refused (v1 rule); Guarded proposal EXECUTION paths are the same
permissionless spl-gov paths GATE 1 proved. The app's guarded launch
runs through the existing runLaunch ceremony (council-mint keypair
co-signs; members list empty — the gate authority is derived).
