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

## D-044 — One create page, one rail; the board is the front page (2026-08-09)

Operator directive: "there should only be a create page with toggle for
simple token, DAO token"; "the front page should be the board … all three
categories showing side by side in columns".

**One rail.** `/launch` (pump.fun rail, MAINNET) and `/create` (our native
curve, devnet) were two products behind two nav tabs. They are now one
page whose toggle changes only WHO the coin's creator is: Simple = you,
DAO = the treasury. The DAO ceremony's coin step therefore swaps pump
`create_v2` for our `create_coin` with `creator = the Squads vault PDA`
(INV-CREATOR-ARG — creator is an argument, never a signer, which is the
property the launchpad suite exists to prove). Consequences: the DAO flow
now WORKS on the deployed devnet cluster (it previously targeted a
mainnet-only rail from a devnet-configured site); creator fees accrue to
the DAO's creator vault from the first trade and anyone can crank them
home; supply/threshold/dev-buy quotes read the curve's live on-chain
config instead of a hardcoded pump constant. `/launch` remains as a
CLIENT-side redirect — a server `redirect()` static-exports to an error
page (verified in app/out), so the hop is a useEffect with a link
fallback.

**The board is the front page** and shows all three columns at once
instead of tabs. This surfaced a real defect: the indexer's "graduating"
filter was `migrated = 0 AND complete = 0` — identical to "new", with the
documented progress threshold accepted but ignored, so two of the three
columns would have rendered the same coins. Fixed (tests first) to
`complete OR progress >= threshold` (default 80% of the reserve sold),
comparing `CAST(real_token AS INTEGER)` because a TEXT compare orders
"8…" above "79…". The bucket rule is now ONE shared function
(`boardBucket`, @daofun/sdk/launchpad) used by the app's chain-direct
path and mirrored by the SQL, so hosted and backend-less boards agree
column for column.

**Nav** is Board | Create. The mode-comparison page is gone; each
protection level carries its own detail inline on the create page.

## D-045 — Your Profile: launcher control room, read from chain (2026-08-09)

A launcher had no way to see their own coins or collect what they had
earned. `/profile` adds it, chain-only (no indexer): wallet summary,
claimable creator fees with a Claim button, and every launch with a link
to its terminal plus a "Graduate now" crank when the curve is complete
but not yet migrated.

**One fee figure, not per coin.** `collect_creator_fee` drains the vault
at seeds ["creator-vault", creator] — ONE vault serving ALL of that
wallet's coins — down to the rent floor, with the destination fixed to
the curve's recorded creator. So the UI shows a single claimable total
(balance MINUS the rent floor the program retains, `claimableFromVault`)
and any of the wallet's mints authorizes the drain. Showing a per-coin
claim would have been fiction. Both this and `graduate` are
permissionless on chain, so the buttons are safe for any visitor.

**FINDING — the size filter is correctness, not optimization.** Launches
are discovered with getProgramAccounts + a memcmp on the curve's
`creator` at offset 40. Measured against devnet, the deployed
BondingCurve is **143** bytes (the trailing `bump` — my first constant
said 142 and matched nothing), and a 277-byte **Config** account ALSO
matches that memcmp because its fee recipient sits at the same offset.
Without `dataSize: 143` a creator who is also the fee recipient — the
platform operator, exactly the person most likely to open this page —
would see their Config decoded as a phantom coin. The e2e stub now
applies dataSize + memcmp the way a validator does and seeds the Config
decoy, so the FILTERS are what the spec proves; the harness's fabricated
curve grew its bump byte to match the deployed size.

## D-046 — FIX: the wallet-cluster preflight blocked legitimate devnet users (2026-08-09)

**Symptom (operator, live):** wallet on Phantom devnet, profile page
correctly showing its 2 devnet SOL, and every send refused before signing
with "Your wallet isn't set to solana:devnet."

**Cause.** The D-038 preflight compared the wallet-standard `chains` list
against the target chain id. That list is what a wallet SUPPORTS, not the
network it currently has selected — wallet-standard exposes no way to read
the active one — and Phantom in Testnet Mode reports a list without
`solana:devnet` while sitting on devnet. The guard therefore rejected the
exact configuration it was meant to serve.

**Fix.** The list only carries information when the WALLET does the
broadcasting, because only then does the wallet pick the network. The
guard now runs exactly when that is true (`(preferWalletBroadcast ||
no signOnly) && signAndSend`). On devnet we take the sign-only path and
broadcast the signed bytes to OUR rpc with OUR blockhash, so the cluster
is fixed by construction and the wallet's selected network cannot affect
where the transaction lands — signing is over message bytes and is
network-agnostic.

The real trap detector is untouched: a wallet-broadcast signature that
never appears on our rpc is still reported as wrong-cluster with the
per-wallet switch hints (D-038's substantive protection).

**Doctrine note.** The e2e that "proved" the guard encoded the bug: it
asserted a mainnet-advertising wallet is stopped. It now asserts the
opposite — that such a wallet trades successfully on devnet — which is
the behavior a real user has. A test can only pin what it was told to
pin; this one pinned an assumption about wallets that the wallets do not
honor.

## D-047 — FIX: injected-provider connections could not sign anything (2026-08-09)

**Symptom (operator, live):** "wallet cannot sign transactions" on create,
immediately after D-046 unblocked the cluster guard.

**Cause.** The app has TWO connect paths. Wallet-standard yields
`{wallet, account}` with signing features. The INJECTED path — preferred
for Phantom/Solflare because wallet-standard connect throws Phantom's
-32603 in some setups (see lib/injected.ts) — yields a provider plus a
BARE `{address}` account, no wallet-standard account object. Yet all
three screens built their signer with `makeSigningWallet(wallet,
account)`, which reads wallet-standard features and needs the real
account. On an injected connection it found nothing to sign with, so the
pipeline reported "wallet cannot sign transactions". Trading and the
profile actions had the same defect; the operator simply hit create
first.

**Fix.** Signer construction moved INTO the wallet provider as
`getSigner()`, which returns the adapter matching the ACTIVE connection —
`signingWalletFromProvider` (new) for injected, `makeSigningWallet` for
wallet-standard. Screens no longer choose. The injected adapter exposes
signOnly (provider.signTransaction) and signAndSend
(provider.signAndSendTransaction), so the devnet rule still holds: sign
only, and we broadcast to our own rpc.

**Why it shipped.** The e2e installed only a wallet-standard fake, so the
path real wallets take was never executed. The harness now also installs
a fake INJECTED provider (window.phantom.solana) and
app/e2e/injected-wallet.spec.ts creates a coin and trades through it —
both fail against the previous code. Coverage of the shape a test
fabricates is not coverage of the shape production uses.

## D-048 — FIX: "sell 100%" asked for more tokens than the wallet held (2026-08-09)

**Symptom (operator, live):** selling 100% failed with
`{"InstructionError":[2,{"Custom":1}]}` — the SPL Token program's
InsufficientFunds surfacing out of our sell instruction.

**Cause, measured against the live wallet.** The balance was
533830845.**549266** tokens. The 100% preset rendered it with
`toFixed(4)` → `"533830845.5493"`, which ROUNDS UP, and the quote parsed
that back with `Math.floor(Number(amount) * 1e6)` → 533830845549300 —
**34 base units more than the wallet owned**. The transfer could not
succeed. Every amount in the panel round-tripped through a double and a
4-decimal string, so any 6-decimal balance whose tail rounded up was
unsellable in full.

**Fix.** `app/lib/amount.ts`: `parseTokenAmount` / `formatTokenAmount` do
the conversion as STRING arithmetic — full precision out, truncation
(never rounding) in — so a value formatted from base units parses back to
exactly those base units. Presets, quotes and the MAX-buy button all use
them (9 decimals for SOL, 6 for tokens). A pre-signing balance check now
also refuses an over-balance amount with a plain sentence naming what you
hold, instead of letting the chain answer with a custom error code.

**Harness note.** The e2e stub gained `getTokenAccountBalance`. First cut
returned zero for an unlisted account, which quietly turned "unknown
holdings" into "holds zero" and hid the position card in another spec;
a real RPC ERRORS on a missing account and the app depends on that
distinction. The stub now returns a JSON-RPC error frame — the fabricated
RPC must copy the real one's failure modes, not just its successes.

## D-049 — G0: Raydium's liquidity locker verified on the binary; graduated coins can pay their DAO forever (2026-08-09)

**Context.** `migrate` burns the LP today. That makes liquidity unpullable
but throws the fee rights away, so a graduated coin earns nobody anything
— the gap PLAN-GRADUATED-FEES.md exists to close. The fix is Raydium's
"Burn & Earn" locker `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE`: lock
the LP, receive a fee-key NFT, and let the key's holder sweep the locked
position's trading fees forever. Before a line of program code, G0 drove
the DEPLOYED binary (deploy slot 362,025,476) in bankrun.
`tests/launchpad-lock-verify.integration.test.ts`, 8/8 green.

**A correction first.** An earlier strings-based inventory of that binary
found three instruction source-paths and I wrote "there is NO
`collect_clmm_fees`", using it to argue CPMM over CLMM. The program's
on-chain Anchor IDL (`HzLkUWn57cdtyQNQLJpyu2EPF8qQAiGt4iuiEo1XnEFK`)
disproves it: there are FOUR instructions, including
`collect_clmm_fees_and_rewards`. Both venues can lock AND collect. §2 of
the plan now argues CPMM on its real merits — full-range by construction
(a locked CLMM position cannot be rebalanced when price leaves its range,
which is exactly what launchpad coins do), a much smaller account/CU
footprint, and a small delta from a migration already proven end to end.
CLMM is deferred, not excluded.

**What the binary actually enforces.**

- Discriminators reproduce as `sha256("global:<name>")[..8]`:
  `lock_cp_liquidity` `[216,157,29,78,38,51,31,26]`, `collect_cp_fees`
  `[8,30,51,199,209,184,247,133]`. Seeds: authority
  `["lock_cp_authority_seed"]` = `3f7Gc…`, record
  `["locked_liquidity", fee_nft_mint]`, locked LP vault =
  `ATA(authority, lp_mint)`. The 19- and 18-account IDL orders are accepted
  verbatim.
- **`recipient_token_0/1_account` are unconstrained.** A payout landed in a
  non-ATA token account owned by an unrelated PDA. This is the fact the
  whole design rests on: our program can hard-wire the destination to the
  coin's creator and let ANYONE crank the collect, exactly like
  `collect_creator_fee`.
- **The fee key is the sole authority.** A thief signing for themselves is
  refused both with their own empty fee-NFT account and while pointing at
  the real one. `locked_owner` in the record is bookkeeping, not authority.
- **A PDA can hold the key and collect**, proven by routing a collect
  through a Squads vault PDA signing via `invoke_signed` — the exact shape
  a dao.fun treasury has.
- **`fee_nft_mint` may be a PDA too.** It is the one slot that must sign,
  and Squads' ephemeral signers (PDAs the Squads program signs for) filled
  it. So `migrate` keeps its single-signer shape — no throwaway keypair
  rides along — and the fee key lands at an address derivable from the coin
  mint.
- **Irreversible.** The dispatcher has exactly four arms: `unlock_*`,
  `withdraw`, `decrease_liquidity`, `close_locked_liquidity` and
  `harvest_*` all bounce with `InstructionFallbackNotFound` before an
  account is read, and CPMM `withdraw` against the locked vault is refused.
- **Idempotent.** A second collect with nothing accrued pays zero and does
  not fail — safe for an unconditional keeper loop.

**The invariant needs restating, and the naive version is false.**
`INV-LP-BURNED` becomes `INV-LP-LOCKED`, but `locked_lp_amount` *decreases*
over time: CPMM keeps the LP share of each trade fee in the vaults, so k
grows and each LP token redeems for more; collecting burns exactly the
slice whose redemption value equals that growth. G0 asserts the bookkeeping
is exact (`Δlocked == Δclaimed`) and that `last_k` never decreases. The
guarantee is **the deposited value never leaves the pool**, not "the LP
count is constant". Anyone reading `locked_lp_amount` as shrinking
liquidity would be misreading it — worth writing down because the
mis-reading is the natural one.

**Costs, measured.** A lock costs **23,328,400 lamports** with metadata
(1,461,600 mint + 2,039,280 fee-NFT ATA + 2,672,640 record + 2,039,280
locked-LP vault + 15,115,600 metadata). Only 5,115,600 of the metadata leg
is rent; the other **10,000,000 is Metaplex's flat create fee**. Without
metadata a lock is 8,212,800, but the fee key then has no on-chain name.
Compute: lock **166,769 CU**, collect **103,408 CU** — a collect fits the
default 200k budget, so the crank needs no ComputeBudget instruction.
Consequence for G1: the curve's migration reserve must rise from
192,156,720 by the full lock cost, or graduations strand mid-flight.

**Fixture note.** The first dump of `raydium_lock.so.gz` kept the 45-byte
ProgramData header, so the "binary" was not an ELF and would never have
loaded. Caught by checking the elf length against `programdata - 45`
rather than by a test failing. The dump script now covers this program
with the same `minSlot` pin CPMM has (D-034), and `fixture-slots.json`
records the slot.

**Devnet, honestly.** `LockrWmn…` is not deployed on devnet and hard-codes
the MAINNET CPMM/CLMM ids, so the lock path can NEVER run there. Deploying
our own copy would test our fork, not the program production uses — the
exact mistake D-031/D-032 exist to prevent. Bankrun against the real binary
is the primary proof; devnet keeps the burn branch (config-gated on the
lock program address) and proves everything around the feature; a mainnet
canary is the only true end-to-end and becomes GATE L4.

## D-050 — The fee model: the coin pays for its own graduation, and keeps earning after it (2026-08-09)

**Directive.** *"what would be a good model for the protocol to earn both
before and after graduating, we want to be reasonable and competitive"*,
after the sharper framing that **we do not own the DEX we migrate into**, so
pump-on-Raydium — not pump-today — is our analogue.

**Model** (PLAN-FEE-MODEL.md; evidence in
research/launchpad/graduation-economics.md):

- **Curve: unchanged 1.00%**, 0.70 protocol / 0.30 creator.
- **Graduation: no fee.** The full 85.005359 SOL raise becomes liquidity.
  The 0.215485 SOL cost is paid from the coin's OWN accrued protocol fees
  (0.595038 SOL by completion — 2.76× cover, by arithmetic).
- **After graduation:** graduate into Raydium's **1% tier**, not the 0.25%
  one. The locked position earns 0.840% of volume. The coin side goes 100%
  to the creator/DAO; the SOL side repays the graduation, then splits
  20/80 — **90/10 by value in steady state**.

**What the competition actually does** (measured, not quoted):

| | curve | graduation | after |
|---|---|---|---|
| pump, Raydium era | 1.00% | **6 SOL from the raise** vs ~0.4 SOL cost | nothing (LP burned) |
| pump today | **1.25%** (0.95/0.30) | 0.015 SOL | creator 0.95% decaying to 0.05% |
| letsbonk | **1.50%** | Raydium's wallet pays 0.2135 SOL | **nothing** (`creator_scale = 0`) |
| Moonit | — | — | 80/20 creator/platform |
| ours | **1.00%** | **nothing** | DAO 0.756%, us 0.084% |

**Corrections this forced.** I had asserted pump's curve pays creators 0.05%
from reading `Global` alone; the newer `pump_fees` `FeeConfig` supersedes it
at 95/30, so pump's curve is 1.25% and its creator share is 0.30% — the same
as ours. And my stonkfun description was wrong twice over (no curve, xStock
quote not USDC, `goonuddt…` is an unrelated program); their liquidity IS
locked, but their fee keys are custodial, which is the gap our design closes.

**Three levers found by measuring rather than assuming:**

1. **Raydium has eight fee tiers and all cost the same 0.15 SOL to create a
   pool in.** Tier choice multiplies the DAO's perpetual income 4× at zero
   marginal cost. Indices DIFFER BY CLUSTER (1% is index 1 on mainnet, index
   3 on devnet), so the tier is stored as an ADDRESS.
2. **Our `pool_state` is our own PDA**, so changing tier moves no derived
   address anywhere — it is a pure config value.
3. **A per-mint protocol vault turns "the protocol subsidises graduation"
   into "the coin pays for itself."** Not a subsidy; earmarking. Per-mint
   rather than global on purpose: a shared vault would make the
   permissionless `migrate` crank depend on somebody topping it up, and a
   drained vault would strand holders' SOL in a completed curve.

**Implementation notes worth keeping.**

- `Config`'s new `lock_program` and `graduated_fee_protocol_bps` are carved
  BYTE FOR BYTE out of the old `reserved: [u64; 8]`, so the size stays 277
  and the already-deployed devnet config still deserializes — as burn +
  zero share, exactly what it meant. Pinned in the build suite.
- The lock is a **separate instruction**, not part of `migrate`: migrate
  already carries ~28 accounts and the locker needs 19 more, which does not
  fit a legacy transaction. The LP is safe in between — its ATA's authority
  is the migration PDA and nothing else moves it.
- `lock_graduated_liquidity` is paid by the coin's protocol vault, including
  reimbursing the cranker for the record's rent. Anchor's `init` bills the
  caller, which would have made "permissionless" mean "whoever will donate
  0.0015 SOL". The test asserts the cranker is out exactly 5,000 lamports.
- `GraduatedFees` is a NEW PDA rather than fields on `BondingCurve`, so no
  existing curve account changes size and devnet coins keep working.

**Deferred:** `collect_graduated_fees` (the split itself). The lock path
cannot run on devnet at all — Raydium's locker is not deployed there and
hard-codes the mainnet CPMM id — so bankrun against the real binaries is its
only proof until a mainnet canary (GATE L4).

## D-051 — The integration flake: a use-after-free in solana-bankrun, now survivable (2026-08-09)

**Context.** The integration suite went red in six of twenty-two full runs
with a test that simply stopped: no assertion, no error, just "Test timed out in
300000ms". Two earlier explanations were wrong. Capping the fork pool ("CPU
contention") only made it rarer. Then I blamed my own new test for standing
up a third bankrun runtime in one file — plausible, and false: with that
fixed, the next hang landed in `gate0b-token2022`, a file I had not touched.

**What it actually is.** Every wedged run contains this, and every green run
contains zero of it:

```
thread 'tokio-runtime-worker' panicked at solana-program-test-1.18.0:716
Program file data not available for `"̌\r\0\0\0\0\x91ϥ…  (DaV3yst…)
```

The program **name** is freed heap memory — those bytes are a pointer sitting
in a reclaimed slot — while the program **id** printed beside it is intact.
So the JS string backing `AddedProgram.name` is read after release inside the
native bridge; solana-program-test cannot find a file by that garbage name
and panics. The panic kills the tokio task **without settling the napi
promise**, so the JS `await` on `start()` can never resume. That is why the
hung worker looked like this under the inspector:

```
{"resources":["PipeWrap","PipeWrap"],"handles":["Pipe","Socket"],"requests":[]}
```

No timers, no pending libuv requests — nothing but tinypool's IPC. An idle
event loop, not a slow call. Ruled out along the way: memory (13 GB free, no
OOM), CPU starvation (the native threads are parked, not spinning), and
`start()` under load on its own (80 back-to-back creations across two
concurrent workers, zero reproductions — it needs the GC to land in the
wrong place).

**Decision.** The bug is upstream and not ours to patch, so the harness stops
depending on it going well:

1. **Watchdog.** Every bankrun call races a 60-second timer
   (`BANKRUN_CALL_TIMEOUT_MS`, 0 to disable), applied once via a Proxy over
   `banksClient`, with the two direct `start()` call sites moved onto a
   `startGuarded` helper. A wedge now fails in 60s NAMING THE CALL instead of
   stalling 300s silently and leaving orphaned workers holding cores for the
   next run. It earned its keep immediately, reporting
   `start(governance+squads+launchpad_curve+cpmm+mpl_token_metadata)`.
2. **One retry, creation only.** The corruption is a per-call race, so a
   fresh `start()` almost certainly succeeds; retrying turns a red run into a
   run that is 60s slower and green. Loud on stderr. Nothing else is
   retried — replaying a transaction blind could double-apply it.

**Also fixed, found while reading the harness:** the fixture inflation was a
TOCTOU race. Every worker runs it at import, so `existsSync` could see a file
another worker was still streaming 1.4 MB into and hand bankrun a truncated
ELF. Now it writes to a per-pid temp name and `rename`s, which is atomic
within a directory. Latent — it needs a fresh clone or a new `.so.gz` to
fire — but it would have looked exactly like another mystery hang.

**Proof it works.** Six verification runs after the change: two hit the wedge
(one on `mpl_token_metadata`, one on `launchpad_curve`), both retried, and
**all six finished 20/20 green**. Runs that would previously have been red now
cost 60 extra seconds instead.

**If the retry ever stops being enough,** the durable fix is to stop using the
name-based loader entirely: pass each program as an `AddedAccount` (executable,
owner `BPFLoader2111…`, data = the ELF bytes we already inflate from
`tests/fixtures`) instead of as an `AddedProgram`. No name, no lookup, no
string for the bridge to mishandle. That is a change across all 20 suites, so
it is not worth the risk while a two-line retry holds.

**Honest residuals.** The upstream use-after-free is unfixed; we route around
it. The retry masks a real defect by design, which is why it is noisy and why
this entry exists. And a contributing factor worth knowing: every wedge
observed happened while a SECOND full suite was running concurrently on this
4-core box (an orphaned run from an earlier session, found only by reading
`ps`) — after killing it, eight consecutive runs were clean. That is a
correlation, not a proof, and it is recorded as one.

## D-052 — A deep pass over the live devnet deployment: two real defects, one hardening (2026-08-09)

Operator directive: mainnet stays parked, keep building on devnet, *"make
sure everything we've built so far is perfect. Do a deep pass on all of it"*.
The pass was written as a script rather than a read-through
(`scripts/devnet-audit.ts`), because a read-through checks what I believe the
code does and a script checks what the chain actually holds. It found two
things a green test suite could never have found, both of which had been live
for a while.

### 1. Legacy coins could not be bought at all

Five of seven devnet coins had NO `["protocol-vault", mint]` account: they
were created before the fee model existed, and the instruction that seeds the
vault came later. `buy` routes the 0.70% protocol fee there with a plain
system transfer, and a transfer to a non-existent account CREATES it — which
the runtime then rejects unless the new account lands rent-exempt. So every
buy whose protocol fee was under 890,880 lamports failed. That is every buy
under about **0.127 SOL**: in practice, all of them.

Proven before fixing, on chain:

```
BEFORE — 0.01 SOL buy on 7kbXce29…
  Transaction simulation failed: Transaction results in an account (5)
  with insufficient funds for rent
```

No program change was needed and none would have helped: the vault is a
system-owned PDA, so anyone may fund it. `scripts/devnet-legacy-vault-fix.ts`
funds each affected vault to the floor and re-runs the same buy, which then
succeeds (`5iwGfqCZ…`). New coins were never affected — `create_coin` seeds
the vault, and `migrate` and `collect_protocol_fee` both retain the floor with
`saturating_sub`, so it cannot be drained back below it. Verified by reading
those two paths, and now guarded by a devnet-smoke assertion.

### 2. The app pointed at a program that does not exist

`app/lib/cluster.ts` carried its own literal copy of the launchpad program id.
After the first real deploy the SDK's copy was updated and this one was not,
so the two disagreed: SDK `DaV3yst…`, app `6s4F21hx…`. Invisible in
production, because the Pages workflow always sets
`NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID` — but any run without it (a local
`pnpm dev`, any other consumer) pointed the entire app at a program that has
never been deployed, and every read came back empty. The app now falls back to
the SDK constant, and a test asserts they are the SAME constant rather than
two equal strings.

### 3. Hardening: the wSOL mint is now pinned in `collect_graduated_fees`

`migrate` pins `wsol_mint` to the native mint; `collect_graduated_fees` did
not. That account decides which of the pool's two sides counts as "SOL" (a
byte-order comparison) and which mint the three wSOL token accounts bind to,
so a free choice is a caller choosing where each payout lands.

It was NOT exploitable, and the test says why rather than asserting it:
substituting the mint alone dies on `ConstraintAssociated`, so the adversarial
construction passes matching token accounts too — and on the unpinned binary
that call reached Raydium's locker and was refused there with its own
`ConstraintTokenMint` (**0x7de**, measured). Raydium was enforcing our
invariant. Now we enforce it ourselves, before any CPI (**0x7dc**,
ConstraintAddress). This file's rule is to derive and check rather than borrow
someone else's validation.

### 4. Reproducibility, established rather than assumed

A forced clean recompile of the unchanged source reproduced the deployed
binary **byte for byte** (`2f085982…`), so source → build → fixture → deployed
devnet program were provably one artifact. After the hardening the chain was
re-established at `5c5854a5…` and redeployed (`2W82hMgj…`).

`devnet-audit.ts` now checks this automatically, with the subtlety that cost
me a confused minute: `solana program dump` returns the ALLOCATED programdata
length, not the ELF length, so a whole-file hash mismatches purely because
`solana program deploy` grows the account with slack. Compare the prefix and
assert the tail is zeros (9,904 bytes of it here).

### What the pass did NOT do

No fresh graduation. A full one costs ~2.83 devnet SOL permanently (the raise
becomes pool liquidity and the LP is burned), three coins have already been
graduated, and the only changed code path — the locker — **cannot run on
devnet at all**. The regression risk from a redeploy is to the paths that
already worked, so `scripts/devnet-smoke.ts` drives those instead: create →
buy → sell → collect_creator_fee → collect_protocol_fee, checking lamports
against the SDK's own quote math rather than checking for the absence of an
error. All green on the newly deployed binary, including the negative one —
a pre-graduation protocol sweep is REFUSED, because that money is earmarked
for the coin's own graduation.

## D-053 — The gate is live on devnet, and devnet is NOT the fork we designed against (2026-08-09)

Operator approved spending devnet SOL for live guarded evidence. Two things
had to be settled before spending any, and both turned out to matter.

### 1. Devnet runs spl-governance 3.1.2, not the 3.1.4 fork

Same address (`GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`), different
program: 1,195,568 bytes on devnet against 1,319,856 on mainnet, version
strings `3.1.2` vs `3.1.4`, and mainnet carries Token-2022 deposit validation
whose strings devnet's build does not contain at all. Squads v4 differs too —
binary AND its on-chain ProgramConfig, which names a different treasury.

This is the D-031/D-032 trap in a new costume. Our entire guarded design rests
on ONE property of the fork (D-042): `min_community_weight_to_create_proposal
= u64::MAX` is an EXPLICIT "disabled" sentinel, not a large threshold. If
3.1.2 treated it as a number, a devnet whale could author and a "successful"
live run would be evidence about a program nobody uses in production.

So `tests/devnet-governance-parity.integration.test.ts` dumps both devnet
binaries as fixtures, pins the difference so a future drift fails loudly, and
re-runs the load-bearing assertions against the DEVNET binaries in bankrun.
**They hold on 3.1.2**: the whale is refused with the same sentinel error, and
the full production guarded ceremony lands. Only then was the live run worth
paying for. Green here is what makes GATE L5 meaningful; red would have saved
2 SOL and a false conclusion.

**It also caught a harness bug no existing test could have.** Squads validates
the `treasury` account against its ProgramConfig, and the harness pinned the
MAINNET treasury for every context — so every DAO test would pass on mainnet
binaries and fail on devnet's (`0x177e`, left `5DH2e3cJ…` right `HM5y4mz3…`).
Production was always correct: the app and the backend both read it from chain
via `fetchProgramConfigTreasury`. The harness now tracks the treasury per
context, so a cluster mismatch is a test failure rather than a blind spot.

### 2. The gate's declared program id was undeployable

`declare_id!` named `3QgQJ4Eu…`, from a build-time keypair that
`programs/target/` (gitignored) once dropped and a later rebuild replaced.
Nobody held that key, the address had never been deployed, and an Anchor
program refuses every instruction whose address differs from its
`declare_id!` — so the gate could never have been deployed to it. The
launchpad's program key had been saved to `.wallets/`; the gate's had not.

**And this was live-breaking, not just theoretical.** `/launch` DEFAULTS to
guarded mode (`create-screen.tsx`), and the guarded ceremony CPIs into the
gate. With no gate deployed at any address, every guarded DAO launch from the
public devnet site failed. The default path was broken and nothing tested it,
because bankrun loads the gate binary by name at whatever id we ask for — a
simulator will happily run a program the cluster does not have.

Adopted the key we do hold, `4UioBmH3WkwYbLN6tumLGrUpXGMwFwcaxt1jbUcZE7Cy`,
saved it to `.wallets/proposal-gate-program.json` beside the launchpad's,
updated `declare_id!` + `PROPOSAL_GATE_PROGRAM_ID`, rebuilt, re-ran the gate
suites green, and deployed (`3RXXk38DTPzD…`). Only the initial deploy needs
that key — upgrades are authorised by the deployer wallet — but losing it
before the first deploy is exactly what happened, so it now lives somewhere
durable. Cost 2.075 SOL of rent; no orphaned buffers.

### 3. The live run

`scripts/devnet-guarded-run.ts` drives the production
`buildCreateDaoIxs("guarded")` against real accounts: realm derived in advance
matches, ceremony lands in three transactions, the gate is bound to the realm
in guarded mode with the full 8-program menu, and its council record holds
exactly one token. Then the two properties guarded mode exists for, on a real
cluster: a holder of the **entire** community supply is refused with
`GOVERNANCE-ERROR: Voter weight threshold disabled`, and an unrelated wallet
authors through the gate — propose, insert, sign off — with the COMMUNITY as
the electorate, which then votes. Evidence in GATES.md GATE L5.

Finalize and execute were not attempted and the run says so rather than
quietly stopping: production params are a 3-day voting window and a 72-hour
hold-up, and a live cluster's clock cannot be warped. The proposal is left in
`Voting`.

### 4. And the e2e suite had the same disease as the bankrun one

Two full e2e runs failed on two DIFFERENT specs, each passing alone — the
"re-run and it's fine" pattern D-051 exists to stamp out. Cause: the suite
served the app with `next dev`, which compiles each route on its FIRST
request, so with four browser workers racing on a 4-core box whichever spec
touched a cold route first could blow its timeout.

Playwright now serves a production build (`next build && next start`;
`E2E_DEV=1` restores the dev server for writing specs). On-demand compilation
disappears, per-test times dropped roughly fourfold (2–3s to ~0.7s), the whole
suite got FASTER despite the up-front build, and it now exercises the artifact
that actually ships rather than a dev bundle. Three consecutive full runs:
33/33, 33/33, 33/33.

## D-054 — The board showed you your own browsing history, not the launchpad (2026-08-09)

**Symptom, reported by the operator:** the coins I had just created on devnet
did not appear on the front end.

**Cause.** Without an indexer the board's discovery was
`loadLocalCoins()` — a localStorage list of "mints this browser has launched
or visited". Every coin then rendered correctly from chain, which is why this
never looked broken to whoever built it: on the developer's own machine the
board is full. For everyone else it is EMPTY, and no coin created anywhere
else — a script, another device, another person — can ever appear. A
launchpad whose front page shows your own history is not a launchpad.

**Fix.** Discovery now comes from the program: one `getProgramAccounts` for
the curves (with the `dataSize` filter, which is CORRECTNESS rather than an
optimization — the Config account is owned by the same program and would
otherwise decode as a coin, the trap `profile.ts` already documents), then one
batched `getMultipleAccounts` for the metadata. Two RPC calls regardless of
how many coins exist. localStorage is demoted to a hint: it still fills in a
coin created seconds ago that the scan's snapshot may not carry yet, which is
the one thing it was genuinely good for. Columns sort by raise, so a coin with
real volume never sits under an empty one.

Metadata failures no longer drop a coin. The curve is the source of truth and
a nameless coin still trades; losing the whole listing because a Metaplex
account was unparseable is the worse outcome.

Verified against live devnet before trusting it: 11 of 11 coins discovered
with names, including every coin the scripts created. The e2e that pins it
seeds two coins and an EMPTY localStorage; it fails on the old code (the board
falls back to the "be the first to launch" empty state) and passes on the new.

**Worth noting for the indexer path.** `apiConfigured()` still short-circuits
to the backend's own bucketing, which does scan. This bug only ever affected
the serverless deploy — which is the deploy that is live.

**And the honest limit.** A full scan returns every curve, 143 bytes each, so
the payload grows with the launchpad: fine at 11 coins, ~1.4 MB at ten
thousand. The backend indexer is the answer at that scale and already exists;
this is the correct behaviour for a serverless deploy, not a permanent
substitute for indexing.

## D-055 — Making the board's cost independent of the launchpad's size (2026-08-09)

Operator, on the board reading the chain directly: *"what about when people
start using it I want it to scale"*. Measured rather than guessed, and the
answer splits cleanly in two.

**One real inefficiency, fixed.** D-054's board fetched metadata for EVERY
coin and only then decided which few dozen to render. At ten thousand coins
that is a hundred extra round trips and several megabytes to draw a hundred
and fifty cards. The ordering is now: scan → bucket and rank on the curve
data the scan already returned → cap each column at 50 → and only then read
names, for what will actually be drawn. Measured against live devnet: **2 RPC
calls**, and `app/test/board-scale.test.ts` asserts the same call count at 10
coins and at 50,000. That property is invisible in the rendered output — the
board looks identical either way — which is exactly why it needed a test that
asserts COST rather than appearance.

**One limit that cannot be fixed client-side, so it is documented instead.**
The scan itself returns ~440 bytes per coin (measured): 4.8 KB today, 0.44 MB
at a thousand coins, 4.4 MB at ten thousand. A client-side full scan is
inherently linear. It is comfortable to roughly a thousand coins and a bad
idea well before ten thousand — and public RPC providers commonly restrict
`getProgramAccounts` on mainnet precisely because of this access pattern.

**The scaling path needs no new architecture.** `packages/backend` is a
working indexer + API + SSE with a `railway.toml`; the app already switches to
it when `NEXT_PUBLIC_API_URL` is set, and the Pages workflow already forwards
that variable. Turning it on is a repo-variable change, and the chain-direct
path stays as the fallback — a resilience property worth keeping rather than
deleting.

Written up in **SCALING.md** with the measurements, the order things break in
(RPC limits first, then indexer throughput, then SQLite, then the board's
ranking semantics), and the cheapest fix at each step. The one finding worth
flagging early: the indexer fetches transactions ONE AT A TIME inside its tick
loop, which is fine at devnet volume and will fall behind a busy mainnet — the
fix is concurrency within a batch, and the cursor semantics already tolerate
it because it applies in slot order and advances only over what applied.

## D-056 — Live updates: push, not poll (2026-08-09)

Operator: *"how can I make this run like a professional trading website where
it updates as things happen"*.

**What it was doing.** The board did not update at all — one read per page
load. The coin page polled for trades every 5 seconds, so the average
staleness was 2.5s and the worst case 5s, and the price only moved when that
poll happened to land.

**What changed.** Solana's RPC has WebSocket subscriptions and a browser can
use them directly, so this needed no backend and no infrastructure decision.
Measured on devnet against a real buy, twice:

```
push arrived 1,025 ms after send   (BEFORE sendAndConfirmTransaction returned)
board updated  511 ms after send   0.223585 -> 0.228536 SOL
```

Every viewer now sees a trade at about the moment the trader does.

- **Board**: one `programSubscribe` covers the whole launchpad. A known coin
  is patched IN PLACE — no refetch, no flicker, and it keeps the name it
  already has — and re-bucketed, because a trade can be the one that pushes a
  coin past the graduating threshold and the column it sits in is part of the
  information. An unknown mint is a coin launched since the last load, which
  needs metadata; that is a debounced reload rather than a read per push, so a
  burst of launches cannot become a burst of RPC.
- **Coin page**: `accountSubscribe` on the curve. The curve is the AUTHORITY
  on price, so it is applied directly rather than triggering a refetch.
- **The tape**: a trade's author and signature exist only in the TRANSACTION,
  so it cannot be served by an account subscription. But the curve changing
  IS the signal that a trade landed, so the push pokes the fetch instead of
  waiting for its next tick — coalesced, so a burst is one fetch.
- **The price flashes**, green or red, keyed on the value so the animation
  re-runs. Short, and honoured by `prefers-reduced-motion`: on a busy coin
  these fire constantly.

**Two things this had to get right, and one I got wrong first.**

`onProgramAccountChange` does NOT throw when the socket is unreachable — it
registers and fails later, asynchronously. My first version reported "live"
because that call returned, which is precisely the dishonest badge the module
claims to prevent: a screen that looks live and is frozen. The status now
follows the SOCKET (`open`/`close`/`error`), so it stays at "connecting" until
the connection is real.

And push alone is not enough. A WebSocket can stop delivering without telling
anyone, so a slow reconciliation read (30s) runs regardless of socket health.
That is what makes a wrong badge cosmetic rather than a data-loss bug, and it
is why the fallback path is honest: an RPC that refuses `programSubscribe`
(providers do restrict it — it is expensive to serve) drops to polling and
SAYS "delayed" rather than pretending.

**The scale note stays true.** `programSubscribe` streams every account the
program touches to every connected client: the right trade at this size, the
wrong one at a hundred times it, which is exactly where the backend's SSE
fan-out takes over (SCALING.md). Live-by-default now, one env var away from
server-fanned later.

## D-057 — Finishing what devnet can finish (2026-08-09)

Operator: *"Whatever is left to do on devnet — let's finish that now."*
`PLAN-DEVNET-FINISH.md` is the scope: every LAUNCH.md item completable without
mainnet SOL and without a decision that is not mine. What follows is what was
built, and — more usefully — what each thing is defending against.

### The gate's last two legs, proven live by outwaiting a real clock

GATE L5 left `finalize` and `execute` untested on a real cluster, because the
production params are a 3-day window and a 72-hour hold-up. Those are the legs
where the gate hands control back to ordinary governance, so leaving them
unrun was leaving the interesting part unproven.

Rather than wait three days, `devnet-guarded-run.ts --fast` runs the SAME
production ceremony against a governance whose window and hold-up are short,
and drives it to `Completed`. Only two numbers differ, and they are governance
CONFIG: every account, every builder, every CPI and the deployed gate binary
are the production ones.

The window is ONE HOUR rather than minutes, and not by choice —
`withCreateGovernance` refuses anything shorter ("baseVotingTime should be at
least 1 hour"). Hand-building the instruction would have bought a faster run
at the cost of no longer exercising `buildCreateDaoIxs`, which is the entire
reason to run this live. An hour of waiting was the cheaper price.

The hold-up is short but **non-zero** on purpose, and the run attempts an
execution inside it and requires the refusal. A hold-up that is configured and
not enforced looks identical on a passing run; the only way to tell is to try
it. And the final check is on the treasury's LAMPORTS, not on the proposal's
state — a proposal that reaches `Completed` without moving the money it
promised passes every state check and is still broken.

The advance logic (finalize / hold-up / execute) moved into
`scripts/lib/gov-advance.ts` so the fast run and the real one cannot drift. If
the fast run proved a different code path than the one that finishes the
production proposal in three days, it would prove nothing about it.

**It ran, and every leg passed** (GATES.md GATE L5 addendum): realm
`5U9Mwwbg…`, proposal `9P7SDER3fJZHNo7RW87fZcv7WQmQDJsJc1y9kJCzSHYz`, finalize
`2AmiVERc…` → Succeeded, an execution inside the hold-up refused with
`Can't execute transaction within its hold up time`, execute `661SMowN…` →
Completed, and the treasury 20,890,880 → 20,889,880 — exactly the 1,000
lamports the proposal named. The whole run cost 0.165 SOL of devnet funds.

### The priority fee was a constant, which is wrong in both directions

`ConstantFeeEstimator` bid a flat 10,000 µlamports: too much on a quiet chain,
and far too little exactly when a launch is hot and everyone is bidding for
the same block. A trade that does not land is the product failing.

`RecentFeeEstimator` samples `getRecentPrioritizationFees` **for the accounts
the transaction writes** — congestion is per-account, so the price of touching
a hot coin's curve has nothing to do with a quiet one's — takes a high
percentile, and clamps. Three guards, each for a different failure:

- a **ceiling**, so a fee spike cannot quietly drain a wallet;
- a **floor**, because the RPC reports the MINIMUM fee per slot and a quiet
  chain reports mostly zeros; bidding zero is how you sit unconfirmed the
  moment the chain wakes up;
- a **fallback to the old constant** when the RPC does not serve the method,
  because degrading below today's behaviour would be a regression dressed as
  an upgrade.

Retries escalate. Critically, that applies to a NEW attempt — the rebroadcast
loop still resends the SAME signed bytes, because re-signing under a fresh
blockhash is how a retry becomes a second, duplicate trade.

And it is shown in the UI. An app that spends a user's money on urgency
without telling them is not one they keep trusting.

**A trap this nearly walked into:** the browser's RPC goes through our proxy
when the API is configured, and the proxy is method-allowlisted.
`getRecentPrioritizationFees` was not on the list, so behind the API every
estimate would have 403'd and fallen back to the constant — the dynamic fee
would have silently not existed in production while passing every test.

### Metrics, and the number that actually matters

**Indexer lag in slots** is the one metric that distinguishes "the market is
quiet" from "the feed is behind". Every other symptom — a stale board, a
missing trade, a flat chart tail — is downstream of it and looks identical
either way.

It is reported as **absent, not zero**, when the chain head cannot be read. A
metric that reports 0 because it failed looks exactly like perfect health, and
it will be believed. `toPrometheus` omits unknowns for the same reason: a
scraped `lag 0` would silence the alert the metric exists for. Gauges that
throw are caught — an observability surface that fails when things are going
wrong is worse than none, because it fails precisely when it is needed.

### One client could deny the fan-out to everybody

`maxClients` was global. One browser opening a thousand connections reached it
alone and every other viewer got a 503 — a denial of service that needs no
exploit, just a loop. There is now a per-client cap alongside it, keyed on the
forwarded address (the socket address is the proxy's, so it would have lumped
every visitor together and locked the site at a dozen users).

That key is client-supplied and therefore spoofable, which is why it is a
FAIRNESS cap and not a security boundary; the global cap remains the backstop.
Both events that can end a connection decrement exactly once — a double
decrement would let the cap drift upward until it capped nothing.

### The client kept reading the chain even with an indexer configured

The board already skipped the chain-direct live path when the API was set, but
the coin page read `fetchCoinFromChain` unconditionally, so the per-viewer RPC
cost survived the change that was supposed to remove it. `read-path.ts` makes
the rule explicit and testable: the indexer serves what it can, the chain is a
FALLBACK, and falling back is **visible** — a silent fallback restores the cost
and hides the outage that caused it.

Reading chain-direct with no indexer configured is NOT degraded; it is the
zero-config design, and flagging it would put an outage banner on a healthy
site. Reads only the chain can answer — a wallet's own balance, a pool's live
reserves for quoting, the whole signing path — stay chain-direct at any scale.
The trading path must not centralise.

### Renders, reconnects, and the tab you are not looking at

- **Coalescing** (`coalesce.ts`): one state commit per frame, keyed by mint so
  a coin's older state is superseded rather than queued. Not a debounce — the
  update still lands on the very next frame, so latency is unchanged and the
  work is a fraction. The key also bounds the buffer, which matters in a
  hidden tab where `requestAnimationFrame` never fires at all.
- **Reconnect** with exponential backoff and **full jitter**. EventSource
  retries on a fixed timer every client shares, so a server restart brings the
  whole herd back at the same instant and finishes what the restart started.
  The jitter is the actual fix; a test that only checked "it retries" would
  pass without it.
- **Resync on every connect**, rather than replaying from a cursor. Events
  published while a client was disconnected are gone from the stream, and a
  gap in a trade tape is invisible — it reads as a quiet minute. A resync
  cannot have a gap by construction; a replay window is only ever as good as
  its retention. We keep no server-side event log, so replay would have been
  the weaker guarantee AND the larger build.
- **Hidden tabs stop scanning.** The 30-second reconcile is a full program
  scan; multiplied by every background tab it was one of the largest avoidable
  costs in the client. It now skips while hidden and reconciles the moment the
  tab returns, so nothing a user can see changes.

### Indexer throughput

Transactions were fetched one at a time inside the tick loop, capping the feed
at (page size × round trip) regardless of how fast the chain moved. They now
fetch concurrently — but apply STRICTLY in slot order, and anything fetched
beyond a read failure is DISCARDED rather than applied. Concurrency is an I/O
detail; ordering is a correctness property, and the cursor advancing only over
the applied prefix is what makes the whole thing resumable.

### The audit grew a --cluster flag

So the mainnet audit (L-26) is a flag on a script proven over months, not a
script written under launch-day pressure. Three expectations invert:

- the CPMM program and the 1% tier are different ADDRESSES per cluster (the
  tier's INDEX differs too — 1 on mainnet, 3 on devnet — which is exactly why
  the config stores an address);
- `lockProgram` must be UNSET on devnet and SET on mainnet;
- migrated pools therefore have LP supply **zero** on devnet (burned) and
  **non-zero** on mainnet (locked), with the graduated-fee record absent and
  present respectively.

That inversion is the point. On mainnet, a zero LP supply would mean the lock
branch silently did not run — the entire post-graduation fee model would not
exist while every screen still said "graduated". The devnet-only audit would
have called that a pass.

### And a disclosure page that names what is not enforced by code

"The LP is burned" is not the whole truth while somebody can still upgrade the
program or move the fee recipient. `/disclaimer` now separates what the chain
enforces, what people hold (upgrade authority, config authority, this website,
your RPC), and what is not guaranteed at all — each with the command to verify
it. A user who learns about these later, rather than here, is right to feel
misled.

## D-058 — Recovering stranded devnet SOL, and the leak that caused most of it (2026-08-09)

Operator: *"recover as much sol as you can from tokens etc."* Devnet SOL is
faucet-limited and this datacenter IP is blocked from the public faucets
entirely (D-052), so stranded lamports here are genuinely scarce.

`scripts/devnet-recover.ts` surveys read-only and acts under `--apply`.
Recovered **0.026466 SOL**: ten token accounts (three empty, seven holding
worthless test tokens, burned under the separate `--burn` flag) at 2,039,280
lamports of rent each, plus a migrated coin's protocol-fee vault. The audit
was re-run afterwards and still passes — burning the deployer's own token
balances touches no curve, pool or LP invariant.

**Burning is behind its own flag on purpose.** On devnet those tokens are
worthless, but "worthless" is a judgement about this cluster, not a property
of the instruction; the same script pointed at mainnet would destroy real
balances. Cheap flags are how that stays a decision rather than an accident.

**What the script refuses to do.** Closing the two deployed programs would
return **5.78 SOL** — twenty times everything else combined — and it is not
offered as a flag, because it deletes the deployment that GATE L2, L3 and L5
are all evidence about. It is also barely a recovery: redeploying costs the
same SOL back, so the number is only real if devnet is being abandoned. DAO
treasuries are likewise left alone: governance-owned by construction, so the
only way out is a proposal through the gate — an hour of voting plus a hold-up
to recover a fraction of a SOL.

**The actual leak, now fixed.** `devnet-guarded-run.ts` funds a throwaway
`voter` and `proposer` with 0.06 SOL each from `Keypair.generate()`, and those
keys never leave the process. Every run therefore stranded 0.12 SOL
PERMANENTLY, and across three runs (including one that aborted on the
`baseVotingTime` floor) about **0.30 SOL was funded into wallets nobody can
ever sign for again**. The run now sweeps them back before exiting, with the
deployer paying the fee so each wallet can return its ENTIRE balance rather
than holding some back for its own fee.

I could not measure exactly what remains in those wallets: finding them needs
`getTokenLargestAccounts`, which the public devnet RPC rate-limits from this IP
(the D-026 constraint again). The funded figure is exact; the residue is not,
and it is unrecoverable either way.

## D-059 — CORRECTION to D-058: the burned tokens were positions, not dust (2026-08-09)

The operator asked the right question — *"no positions to sell?"* — and the
answer is that D-058 destroyed value. This entry quantifies it exactly and
records the guard that makes the mistake unrepeatable.

**What actually happened.** The seven "worthless test tokens" burned under
`--burn` all had markets. Four were full 793,100,000,000,000-unit positions in
GRADUATED coins whose Raydium pools were live, quoted with the SDK's own
`cpmmSwapBaseInputQuote` against the observed reserves:

| position | pool held | selling would have returned |
|---|---|---|
| `5cWwoLPp…` | 2.665 SOL | 2.109 SOL |
| `8PnhcD5R…` | 2.641 SOL | 2.090 SOL |
| `42io3su1…` | 2.665 SOL | 2.109 SOL |
| `5r9Tznj5…` | 2.661 SOL | 2.106 SOL |

The other three sat on LIVE curves: `H1PBTihw…` worth 0.498 SOL, `EPxbNBCw…`
0.099 SOL, `EfWLyjtM…` 0.010 SOL. Total: **~9.02 SOL destroyed to reclaim
0.014 SOL of account rent.** The recovery run was net −9.0 SOL.

**Why it is unrecoverable.** The burn reduced each mint's supply; no swap can
retrieve the pools' SOL without putting equal value in, and there is no LP to
redeem — the burn-the-LP guarantee the audit proves is precisely what makes
this permanent. The strongest property in the protocol worked exactly as
designed, against us.

**The root cause was a category error in D-058's own reasoning.** It said
"on devnet those tokens are worthless" — treating CLUSTER as what confers
value, when what confers value is A MARKET. These coins had markets ON devnet;
the SOL in those pools was the same faucet-scarce SOL the whole exercise was
trying to recover. The tell that should have stopped me: the recovery script
itself lists migrated pools holding ~2.6 SOL each, on the same screen as the
0.002-SOL rents it was busy reclaiming.

**The fix** (`devnet-recover.ts`, rebuilt): every position is PRICED before
anything is decided — graduated coins against their pool, curve coins against
`sellQuote` — and printed with its value. `--sell` liquidates through the same
SDK builders the app trades with (5% slippage tolerance: a cleanup tool
exiting a position it is abandoning prefers a slightly worse fill to a failed
one). `--burn` now refuses, unconditionally, to burn anything with a live
market — the guard is not flag-overridable, because the whole failure was a
flag being easier to type than a valuation.

Re-surveyed after the rebuild: zero token accounts remain, so there is nothing
left to sell or to save. The guard exists for the next wallet, not this one.
