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

## Open (verify) items — to resolve before/at their first use

- ~~spl-gov v3 Veto vote config~~ RESOLVED: D-011
- ~~SPL Governance proposal state-machine immutability after sign-off
  (INV-9)~~ RESOLVED at the evidence level: GATE 1 phase 2 re-read the
  wrapped ixs from chain post-execution and their hash matched the
  artifact published at proposal time
- Merkle distributor deployed program ID (Stage 1, `distribute` action)
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
