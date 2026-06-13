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

## D-033 — Option A SHIPPED: Guarded mode = gate front door (creation exclusivity verified, then built end to end) (2026-06-12)

Operator decision: "try option A" then "implement A end to end" (this
session). Both halves done, tests-first throughout, everything on the
real GovER5 binary in bankrun.

**The spike (tests/stage3-guarded-spike.integration.test.ts) — the
D-032 "UNVERIFIED RISK" is resolved, all five fork-semantics questions
answered YES on the deployed binary:**

1. `minCommunityTokensToCreateProposal = u64::MAX` refuses creation for
   a whale who DEPOSITED the entire community supply — and for the
   whale's governance delegate (same error code: it is the weight
   check; no loophole). u64::MAX is unreachable rather than relying on
   any "disabled" special-case: no real deposit or VSR weight (digit
   shift 0, max 1x lockup multiplier) can reach it.
2. A COUNCIL TokenOwnerRecord can author a proposal whose VOTING
   population is the COMMUNITY mint; the community passes it; it
   executes. This is the gate's creation seat.
3. With the gate seat holding H+1 council tokens against
   `minCouncilTokensToCreateProposal = H+1`, no human member (1 token)
   can author — and even ALL H humans pooled stay below the bar, so
   exclusivity is structural, not behavioral. Humans keep the veto.
4. Council veto on a gate-authored community proposal works with the
   threshold percent ADJUSTED for the gate seat's share of the 2H+1
   council supply (1-of-2 humans at 20% < 30% does not tip; 2-of-2 at
   40% does, under Strict council tipping).
5. Realm authority parks on a NON-SIGNING PDA via
   SetRealmAuthority(SetUnchecked); the old authority is locked out
   (0x234 Invalid Authority for Realm).

**The build (proposal-gate v2 + SDK; proven by
tests/stage3-guarded.integration.test.ts end to end):**

- **Ceremony (buildCreateDaoIxs, mode "guarded")**: council REQUIRED
  (spec 12.2 veto column); council mint mints 1/human + H+1 to the gate
  PDA's ATA, then null authority; realm-level
  minCommunityWeightToCreateGovernance AND the governance's
  minCommunityTokensToCreateProposal welded to u64::MAX; minCouncil =
  H+1; councilVeto = `guardedVetoPercent(H, nominal)` (chosen STRICTLY
  between the k*-1 and k* human-vote shares, so it is correct under
  either >=/> comparison semantics — property-tested for H 1..20 x
  nominal 1..100); realm authority -> gate PDA (SetUnchecked); new
  `gateSetup` group: gate `initialize` (immutable config: mints,
  requester threshold, mode, whitelist) + `deposit_council` (gate CPIs
  DepositGoverningTokens signing as its own token owner — H+1 into its
  TOR, Membership type: never withdrawable).
- **Gate program v2 instructions** (all CPI layouts pinned from
  @solana/spl-governance 0.3.28 — the client every GATE 1 suite proved
  against this exact binary — and re-proven here by use):
  `guard_create_proposal` (requester signer pays everything and must
  hold >= the tier proposal threshold of community tokens in a token
  account; pinned single-choice Approve + deny option; ProposalMeta PDA
  records the requester), `guard_insert_transaction` (while guarded:
  the D-030 validation engine runs on the EXACT borsh
  Vec<InstructionData> bytes forwarded to the governance program — no
  reserialization between validation and storage; refuses off-menu
  outer programs, unwraps the Squads vaultTransactionCreate message and
  refuses off-menu INNER programs, refuses buffered messages and ALTs,
  and HARD-REFUSES any leg targeting the governance program itself —a
  SetGovernanceConfig/SetRealmConfig leg is how a winning vote would
  re-open the front door; the gate program itself is always admissible
  so the voted ratchet can ride), `guard_sign_off`/`guard_cancel`
  (requester-gated pass-throughs; the gate owns every proposal so these
  are the only path), `release_realm_authority` (refused while guarded;
  after a voted ratchet it permissionlessly hands the realm to its own
  governance via SetChecked).
- **The exit story (proven in one test run)**: voted ratchet leg
  (direct leg, governance PDA signs through execution) -> gate mode
  council; `release_realm_authority` -> realm authority == governance;
  arbitrary (previously off-menu) inserts now pass the gate (12.2:
  council admits "menu + arbitrary"); a voted SetGovernanceConfig
  restores minCommunityTokensToCreateProposal and the whale creates
  DIRECTLY — the realm converges on a standard MVP council DAO with a
  vestigial gate. No exit-template machinery needed.

**Honest limits / consequences (documented, not hidden):**

- `setParam` is UNAVAILABLE while guarded (it is a SetGovernanceConfig
  leg, which the gate hard-refuses). Re-admitting it safely needs
  on-chain floor-validation of the config bytes — already on the GATE 3
  "byte-enforced menu" road (D-030 honest limits). Available again
  post-ratchet.
- spl-governance caps outstanding proposals per owner TOR (~10); the
  gate TOR owns ALL guarded proposals, so a guarded realm has a
  realm-wide cap on simultaneously-active proposals. Cancel/finalize
  releases slots (guard_cancel proven). Acceptable for the product;
  revisit only if real DAOs hit it.
- The requester check reads a TOKEN ACCOUNT balance (holdings), not
  locked/VSR weight — deliberate: on VSR realms governance deposits sit
  in the VSR vault so TOR deposits are 0, and creation-spam economics
  only need skin, not lockup. Works uniformly on no-addin and VSR
  realms (the gate's council TOR needs no voter-weight record because
  the council token config has no addin).
- Gate `initialize` is first-come per realm PDA. A front-runner who
  initializes "our" gate between ceremony transactions makes the
  ceremony's gateSetup FAIL LOUDLY (init collision) — launch aborts
  visibly, nothing custodied; relaunch with a fresh mint. Folds away
  entirely with the single-tx launch-coordinator (spec 6.9).
- Buffered Squads chains (account-spanning messages) remain refused in
  guarded mode — large inner sets must split across proposals.
  buildGateProposeIxs throws instead of building the buffered wrap.

Suites: stage3-guarded-spike (binary semantics evidence), stage3-guarded
(end-to-end lifecycle incl. bypass attempts), stage3-gate (v1 engine +
ratchet still green on the v2 artifact), packages/sdk/test/gate.test.ts
(veto arithmetic property tests + wire-format round-trip). tsc is now
clean repo-wide (pre-existing RawMint literal-type errors in action-amm
fixed per operator instruction "the bar is no errors").

## D-034 — Consolidation onto the live static dapp + GitHub Pages go-live (2026-06-13)

The work scattered across three sibling branches (all off `919c98a`) is
merged onto the deployed static-dapp lineage and made live, per operator
instruction ("ship everything we coded incl. the gate, make it live on
Pages"; "no current DAOs active — just make sure it works"):

- **From `audit-execution-oaj5aa`**: the browser-safe SDK
  (`sha256.ts` replacing `node:crypto` across artifact-hash /
  execution-adapter / merkle-distributor / vsr / gate, so the SDK bundles
  for the static client), `chain-reader.ts` (RpcChainReader — the INV-9
  recompute from the AUTHORITATIVE on-chain tx count, anomaly detection),
  `decode.ts` (INV-10 effects decoder, rug-flagging MintTo/SetAuthority/
  unknown), `verify.ts` (verifyDao buyer-trust primitive), plus
  `governance-tx.ts` / `launch-plan.ts` / `snapshot.ts` and the audit
  test suites + AUDIT-FINDINGS.md.
- **From `option-a-exploration-p6iybh`**: Guarded mode end to end
  (D-033) — proposal-gate v2, `gate.ts`, the guarded ceremony, prod
  wiring, and the stage3-guarded suites.
- **`governance.ts` was hand-synthesized** to carry BOTH lineages: the
  Token-2022 retargeting (D-013/F-1 — the live app launches Token-2022
  pump mints) AND the guarded ceremony (gate seat, welded front door,
  realm authority → gate PDA). Verified on real binaries: gate1-matrix
  (Token-2022 launches) and stage3-guarded (gate ceremony) BOTH green in
  the same suite run (17 integration files / 31 tests).
- **UI re-implemented on the static Phantom shell** (the old
  server-architecture app files were dropped in the merge): proposal page
  recomputes the INV-9 hash in-browser ("verified against chain" badge),
  decodes effects, surfaces anomalies, and cranks permissionless
  execution; dashboard verifies custody + config (verifyDao) and exposes
  a permissionless collect-fees button; launch has a realm-squat guard
  (AUDIT-D) and deep-links to the verify dashboard.

**Deployment**: `claude/zen-cori-t9td4x` added to `deploy-pages.yml`
triggers so a push publishes the static export to
`https://mtremolada.github.io/dao.fun/`. Reads ride the user's
RPC/wallet (public mainnet default + `?rpc=` override) — no server, no
secret, per operator ("the users have RPCs in wallets when they
connect").

**SAFETY LINE held (not improvised):** Guarded ships as integrated,
real-binary-tested CODE, but the custom `proposal-gate` program is NOT
deployed to mainnet and Guarded stays UNSELECTABLE in the public UI.
Putting strangers' treasuries through unaudited custom code violates the
spec's hard rule (no mainnet custom program before GATE 3's external
audit) and Section 11 (no agent-generated mainnet upgrade key). The
mainnet gate-program deploy is the operator + audit step; everything that
rides ONLY audited deployed programs (Council/Cypherpunk/Sovereign
launch, deposit, vote, execute, collect, verify) is live now.

Green at go-live: sdk 181 + backend 89 + app 23 unit; 17 integration
files / 31 tests on real binaries; root + app tsc + eslint clean; static
export builds.

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
