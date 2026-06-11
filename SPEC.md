# PumpFun DAO Launchpad — Spec-Driven Development Plan

**Version:** 2.0 — supersedes v1.1 entirely. Fable: use only this document.
**Audience:** Claude Code agent (Fable 5) executing the build; Matt (operator) reviewing gates.
**Human-in-the-loop:** Exactly one manual action across the entire lifecycle — the operator sends real SOL to two named wallets at the mainnet boundary, and supplies two addresses he already controls. Devnet is fully autonomous, including zero third-party API signups (public RPC defaults).
**Doctrine:** Spec-first. Every component has a contract and a test written before implementation. This system moves real funds on-chain; the test is the spec made executable. No fund-moving code ships without a green test asserting balances before and after.

## Changelog v1.1 → v2.0 (read this, operator)

1. **Keeper “protocol cut” was impossible as written.** The keeper is a permissionless fee-payer with no authority over the vault; it cannot skim a cut from collected fees. Replaced with: protocol revenue = flat launch fee (always) + pump native Creator Fee Sharing configured at launch *if* GATE 0c validates it; otherwise launch fee only in MVP. Programmatic splits arrive with the Stage 3 coordinator.
1. **Stage 4 “treasury migration” was impossible.** pump’s `creator` is effectively immutable post-launch, so existing tokens can never re-point fees at a new treasury. Stage 4 is redefined: new launches gain fully-programmatic custody (coordinator PDA as creator); existing DAOs keep their Squads vault — which is already on-chain custody (see #3).
1. **The Realm→Squads execution linkage was unspecified and is now the core of the design.** The Squads vault has exactly ONE member: the Realm’s governance native-treasury PDA (threshold 1). No human key is ever in the custody path — INV-7 now holds from Stage 1, not Stage 4. A new ExecutionAdapter component wraps proposal instructions in the Squads CPI chain.
1. **Chicken-and-egg solved by advance PDA derivation.** Realm address derives from its name; we set name = mint pubkey, so the native-treasury PDA is derivable *before* the realm or token exists. The Squads vault is created with that predicted PDA as sole member, then the token launches, then the realm is created and must match the prediction. No temporary custody window.
1. **Mode × tier contradiction resolved** (v1.1 said micro-tier requires council veto AND that Cypherpunk has no veto). New rule: mode governs the veto and capability surface; tier governs timelock/quorum/lockup floors. Cypherpunk timelock = max(24h, tier hold-up).
1. **Sovereign row was self-contradictory** (timelock “none” and “6h floor”). Fixed: Sovereign timelock is configurable ≥ 0, including zero, behind a double confirmation.
1. **Guarded mode cannot be enforced on-chain in MVP** (SPL Governance cannot whitelist instruction types). Honest re-scope: MVP ships Council and Cypherpunk modes (both structurally enforceable with native programs); Guarded mode ships at Stage 3 with the guard program. v1.1 promised a guarantee the MVP architecture could not deliver.
1. **`distribute` redefined as a Merkle claim distributor** (push-payments to thousands of holders is infeasible); **`buyback` pinned to the token’s own curve/pool** (governance CPI through Jupiter’s dynamic routes is not realistic); **`migrateRail` removed** from the DAO menu (creator immutability makes per-token rail migration meaningless — rail choice is per-launch, platform-level).
1. Added: environment/config spec with zero-signup defaults, agent execution checklist (Section 13), VSR implementation note (min-lockup is approximated via zero baseline weight — there is no native hard gate), simulation/decode artifact storage design, CU-budget and clock-warp test guidance.

-----

## Table of contents

1. How the agent must work
1. Glossary & canonical references
1. Architecture & invariants
1. Repository layout, tooling, environment
1. Data schemas & types
1. Anti-capture tiers and the mode × tier matrix
1. Component specs (contract + tests)
1. Stage gates with acceptance criteria
1. Test strategy
1. Fallback rail spec
1. Definition of Done
1. Wallet & key management
1. Proposal execution model & governance modes
1. Agent execution checklist

-----

## 0. How the agent must work

1. **Spec before code.** For each component: read its contract, write the failing test, implement until green. Non-negotiable for anything touching funds, PDAs, or governance.
1. **Verify, don’t assume.** Items marked **(verify)** are believed-correct but must be checked against the live IDL / installed package source before use. Training-data recall of these interfaces is treated as unreliable. Record every verification in `DECISIONS.md`.
1. **Gates are hard stops.** Run the gate’s verification, write raw evidence (tx signatures, balances, test report) into `GATES.md`, report to operator, wait for sign-off.
1. **No silent workarounds in fund paths.** A failed fund-handling assertion stops the stage. Report; do not improvise.
1. **Maintain `PROGRESS.md`** — a running log of completed checklist items (Section 13), so any fresh session can resume without re-discovery. Pin exact dependency versions in `VERSIONS.md` at Stage 0; commit lockfiles.
1. **Determinism over cleverness.** Model output that touches money is validated by the harness (tests + on-chain checks), never trusted as authoritative.

-----

## 1. Glossary & canonical references

**Terms**

- **Treasury vault** — the Squads v4 vault PDA that is the pump `creator` and holds swept fees. Sole multisig member: the Realm’s governance native-treasury PDA.
- **Governance PDA chain** — Realm → Governance → native-treasury PDA. The native treasury “signs” executed proposal instructions via SPL Governance’s `invoke_signed`.
- **ExecutionAdapter** — TS builder that wraps a proposal’s inner instructions in the Squads vault-transaction CPI chain so a passed Realm proposal can move vault funds.
- **Rail** — launch venue (pump.fun; Meteora DBC fallback) behind the `LaunchRail` interface.
- **Keeper** — off-chain service that permissionlessly triggers fee collection. It has no authority; it only pays tx fees.
- **VSR** — Voter Stake Registry; vote weight from token lockup.

**Program IDs (pump deployed at same address on devnet)**

|Program                          |ID                                               |
|---------------------------------|-------------------------------------------------|
|Pump bonding curve               |`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`    |
|Pump AMM (PumpSwap)              |`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`    |
|PumpFees                         |`pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`    |
|SPL Governance (default instance)|`GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`   |
|Voter Stake Registry (reference) |`vsr2nfGVNHmSY8uxoBGqq8AQbwz3JwaEaHqGbsTPXqQ`    |
|Squads v4                        |`SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`    |
|Merkle distributor (Jito fork)   |resolve exact deployed ID at Stage 0 **(verify)**|

**PDA derivations (all (verify) against installed package versions; record in DECISIONS.md)**

- Pump creator vault: `["creator-vault", creator]` (hyphen). PumpSwap: `["creator_vault", coin_creator]` (underscore).
- SPL Governance: realm = `["governance", realm_name]`; governance = `["account-governance", realm, governed_seed]`; native treasury = `["native-treasury", governance]`.
- VSR registrar = `["registrar", realm, community_mint]`.
- Squads v4 vault: derive via `@sqds/multisig` `getVaultPda(multisig, index)`.

**Advance-derivation rule (load-bearing):** realm_name := the token mint pubkey (base58). Because the mint keypair is generated client-side before launch, the entire PDA chain — realm → governance → native treasury — is computable before any account exists. This is what lets the Squads vault be configured with its final, permanent sole member from the first instruction.

**SDKs:** `@pump-fun/pump-sdk`, `@solana/spl-governance`, `@sqds/multisig`, `@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`. Test infra: `solana-bankrun` (clock warp) + `solana-test-validator --clone`. Indexing (optional, feature-flagged): Helius. IDLs: `pump-fun/pump-public-docs`.

-----

## 2. Architecture & invariants

**Launch sequence (MVP, multi-tx, no custom program):**

```
1. Generate mint keypair (optionally vanity-ground)
2. Derive: realm/governance/native-treasury PDAs from mint (advance rule)
3. Create Squads multisig: members = [native-treasury PDA (Propose+Vote+Execute)], threshold 1
   → vault PDA = the future pump creator
4. Collect flat launch fee: launcher → protocol-treasury (same bundle)
5. pump create_v2: mint = generated keypair, creator = vault PDA
   (+ optional dev-buy; + fee-shares config if GATE 0c passed)
6. Create token-launch Realm (name = mint pubkey) + Governance + deposit config
7. Register VSR plugin (baseline weight 0 — see 6.3), set tier/mode params
8. If mode == Council: create council mint, mint 1 to each council member, null authority
9. Assert end-state invariants (INV-1, INV-5, sole-member prediction)
```

**Steady state:** keeper triggers permissionless collect → SOL accrues in vault → holders lock (VSR) → propose → vote → hold-up elapses (→ no council veto, in Council mode) → SPL Governance executes the ExecutionAdapter-wrapped instructions → Squads vault funds move exactly as voted.

**System invariants (each maps to ≥1 test):**

- **INV-1** Every launched token’s pump `creator` == its DAO’s Squads vault PDA. Never a user wallet.
- **INV-2** Fee collection requires no creator signature; the keeper signs only as fee-payer.
- **INV-3** No proposal executes before its hold-up elapses (exception: Sovereign mode with explicitly configured hold-up 0).
- **INV-4** A fund-moving proposal requires VSR lockup-weighted YES ≥ threshold, and in Council mode, absence of veto.
- **INV-5** Mint authority is null after launch (pump guarantees; we assert).
- **INV-6** All balance arithmetic is checked math; no silent overflow.
- **INV-7** From Stage 1, the custody path contains no human-held unilateral key: the vault’s sole member is the governance native-treasury PDA.
- **INV-8** Vault inflow per sweep == gross accrued creator fees for the vault (full amount; no skim exists at this layer). Any fee split exists only as immutable pump fee-shares set at launch (GATE 0c) or inside the Stage 3 coordinator.
- **INV-9** Executed proposal instructions are byte-identical to what voters saw: instruction set is inserted before voting and immutable after sign-off **(verify SPL Governance state machine)**; UI artifacts are keyed to the on-chain instruction-set hash.
- **INV-10** Every proposal surfaces a simulation + decoded summary before voting opens; undecodable instructions are flagged, never hidden.
- **INV-11** Governance mode ratchets only toward decentralization. MVP enforcement is governance-level (see 12.2 caveat); Stage 3 makes it structural.

-----

## 3. Repository layout, tooling, environment

```
pumpfun-dao-launchpad/
├── programs/
│   ├── launch-coordinator/   # Stage 3
│   └── proposal-gate/        # Stage 3 (Guarded mode enforcement)
├── packages/
│   ├── sdk/                  # rails, PDAs, ix builders, ExecutionAdapter, types
│   ├── keeper/               # permissionless sweep service
│   └── backend/              # launch orchestration API + artifact store
├── app/                      # Next.js frontend
├── scripts/                  # init-wallets, gate validations, e2e
├── tests/                    # cross-package integration/e2e
├── PROGRESS.md  DECISIONS.md  GATES.md  VERSIONS.md
└── tooling: pnpm workspaces, TS strict, Anchor 0.30+ (pin exact), Vitest,
            solana-bankrun, Playwright, eslint/prettier, GitHub Actions
```

**Environment spec (`.env.example`, all defaults work with zero signups):**

```
CLUSTER=devnet
RPC_URL=https://api.devnet.solana.com        # public default; Helius optional
HELIUS_API_KEY=                               # optional; features degrade gracefully
PROTOCOL_LAUNCH_FEE_LAMPORTS=50000000         # 0.05 SOL default, operator-tunable
PROTOCOL_SHARE_BPS=1000                       # only used if GATE 0c passes
ARTIFACT_STORE=sqlite:.data/artifacts.db      # sim/decode artifacts (12.4)
```

**Tx hygiene:** every sent tx sets a compute-budget ix and a priority fee; confirmation level `confirmed` for test flow, `finalized` for gate evidence; blockhash-expiry retries with idempotency keys in the orchestrator.

**CI:** unit + integration on every PR against `solana-test-validator` with pump/governance/VSR/Squads cloned from mainnet (`--clone <id> --url mainnet-beta`); bankrun for clock-warp suites. Merges blocked on red.

-----

## 4. Data schemas & types

```ts
// packages/sdk/src/types.ts
export type GovernanceMode = "council" | "cypherpunk" | "sovereign" | "guarded"; // guarded: Stage 3+
export type MarketCapTier = "micro" | "small" | "mid" | "large";

export interface LaunchParams {
  metadata: { name: string; symbol: string; uri: string };
  daoConfig: DaoConfig;
  devBuyLamports?: bigint;
  rail: "pumpfun" | "meteora-dbc";
}

export interface DaoConfig {
  mode: GovernanceMode;
  marketCapTier: MarketCapTier;          // sets floors per Section 5
  councilMembers?: PublicKey[];          // required iff mode == "council"
  councilVetoThresholdPercent?: number;  // iff council
  sovereignHoldUpSeconds?: number;       // iff sovereign; >= 0; double-confirmed
}

export interface GovernanceParams {     // resolved via Section 5 matrix
  lockupSaturationSeconds: number;
  quorumPercent: number;                 // of max voter weight (verify semantics)
  proposalThresholdTokens: bigint;
  holdUpSeconds: number;
  vetoEnabled: boolean;                  // structural: council mint exists or not
}

export interface TreasuryRef {
  multisigPda: PublicKey;
  vaultPda: PublicKey;                   // == pump creator (INV-1)
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;             // sole multisig member (INV-7)
}

export interface LaunchResult {
  mint: PublicKey;
  treasury: TreasuryRef;
  mode: GovernanceMode;
  txSignatures: string[];
  mintAuthorityNull: boolean;            // must be true (INV-5)
  predictedPdasMatched: boolean;         // must be true (advance rule)
}

export interface SweepResult {
  vault: PublicKey;
  grossLamports: bigint;                 // full amount; no skim (INV-8)
  signature: string;
  venue: "curve" | "amm";
}

export interface LaunchRail {
  buildCreateTokenIxs(p: LaunchParams, creator: PublicKey, mint: Keypair): Promise<TransactionInstruction[]>;
  buildCollectFeesIxs(creator: PublicKey): Promise<TransactionInstruction[]>;
  deriveCreatorVault(creator: PublicKey): PublicKey;
}
```

-----

## 5. Anti-capture tiers and the mode × tier matrix

**Tier floors (operator-tunable constants):**

|Param                         |micro (<$50k)|small ($50k–$300k)|mid ($300k–$5M)|large (>$5M)|
|------------------------------|-------------|------------------|---------------|------------|
|Effective min lockup (see 6.3)|30d          |14d               |7d             |3d          |
|Lockup saturation             |365d         |365d              |180d           |90d         |
|Quorum %                      |25           |20                |15             |10          |
|Proposal threshold            |2% supply    |1%                |0.5%           |0.25%       |
|Hold-up floor                 |72h          |48h               |36h            |24h         |

**Resolution rule (fixes the v1.1 contradiction):**

- **Mode** decides capability surface and whether a vetoer exists.
- **Tier** decides numeric floors (lockup, quorum, threshold, hold-up).
- Cypherpunk hold-up = max(24h, tier floor). Council hold-up = tier floor. Sovereign = configured value ≥ 0 (exempt from floors; double-confirmed). Guarded (Stage 3) = tier floor at maximum strictness.
- Any mode may launch at any tier; the absence of a veto in Cypherpunk at micro tier is compensated by the strictest floors, and the property test must still show no profitable capture path (Section 8).

**Property obligation:** for randomized (supply, price, attacker budget), no buy → lock → propose → drain sequence completes within the lockup + hold-up window at any tier/mode combination shipped. The Beanstalk pattern (vote and execute in one transaction) must be structurally impossible everywhere except explicitly-configured Sovereign hold-up-0, which the test treats as out-of-warranty by design.

-----

## 6. Component specs (contract + tests)

Write tests first. All devnet/integration tests assert balances and owners explicitly.

### 6.1 `sdk` — PumpFunRail

**Contract**

- `deriveCreatorVault` returns the hyphen-seed PDA; a sibling helper returns the AMM underscore variant.
- `buildCreateTokenIxs` encodes `creator` == provided pubkey (INV-1), creator never a signer; mint = provided keypair.
- `buildCollectFeesIxs` returns permissionless collect ix(s); only signer is fee-payer (INV-2).
- `buildFeeSharesAtLaunchIxs(protocolBps)` — constructs the Creator Fee Sharing config (protocol wallet + vault as shareholders) executable within the launch ceremony, then admin-revoked → immutable. Gated by GATE 0c; if 0c fails, this builder throws `FeatureUnavailable`.

**Tests** (`sdk/test/pump-rail.test.ts`)

- vault PDA matches a known on-chain vault (both seed variants).
- create ix: creator field == provided pubkey; `isSigner === false` for creator.
- collect ix signer set == {fee-payer}.
- fee-shares builder output matches IDL layout (verify) or throws when 0c=fail flag set.

### 6.2 `sdk` — Treasury (Squads, single-member design)

**Contract**

- `createTreasury(predictedNativeTreasury)` creates a Squads v4 multisig with members = [predictedNativeTreasury : Propose+Vote+Execute], threshold 1; returns `{ multisigPda, vaultPda }`.
- Vault PDA is non-executable, Squads-program-owned, ≠ default pubkey (pump creator constraints).
- Config is final at creation; no config-change path is built in MVP (nothing to change — sole member is the governance PDA).

**Tests**

- vault satisfies pump creator constraints.
- sole member == predicted native-treasury PDA; threshold == 1.
- a non-member keypair cannot create/approve/execute a vault transaction (assert rejection).
- vault lamports cannot move via raw SystemProgram transfer (owner check).

### 6.3 `sdk` — Governance (Realms + VSR + council)

**Contract**

- `createDao(mint, params, mode)`: creates Realm (name = mint pubkey — must match advance derivation), Governance, native treasury; registers VSR as community voting plugin; applies `GovernanceParams`.
- **VSR implementation note (honest):** VSR has no native “minimum lockup to vote” gate. We approximate it: `baseline_vote_weight_scaled_factor = 0` so unlocked deposits carry **zero** weight, and weight scales with lockup toward saturation. The tier’s “effective min lockup” is enforced as a UI/SDK floor on deposit creation plus quorum math that renders sub-floor lockups negligible. Document this in user-facing docs; do not claim a hard on-chain gate.
- Mode is structural: **Council** → council mint created, 1 token per member, mint authority nulled, veto enabled at `councilVetoThresholdPercent` **(verify spl-gov v3 Veto vote config)**. **Cypherpunk/Sovereign** → no council mint exists; veto is structurally impossible.
- Realm authority is transferred to the governance itself post-setup (no platform backdoor).

**Tests**

- realm name == mint pubkey; native treasury == prediction (advance rule).
- VSR registered; unlocked deposit votes with weight 0; locked deposit weight grows with lockup (bankrun clock-warp).
- Council mode: veto by council during hold-up blocks execution. Cypherpunk: no council mint account exists.
- hold-up == resolved matrix value; early execution attempt fails (INV-3).
- realm authority == governance (no platform key retains control).

### 6.4 `sdk` — ExecutionAdapter (new; the custody seam)

**Contract**

- `wrap(innerIxs[]) → proposalTxs[]`: produces the ordered SPL-Governance ProposalTransaction set that, on execution, has the native-treasury PDA (sole Squads member) create, approve, and execute a Squads vault transaction containing `innerIxs`, signed via SPL Governance `invoke_signed`.
- Handles CU limits by splitting across multiple ProposalTransactions executed in order; measures CU in tests.
- Round-trips: `unwrap(proposalTxs) → innerIxs` for the decoder (12.4).

**Tests** (`sdk/test/execution-adapter.test.ts`, local validator with cloned programs)

- full path: insert wrapped txs into a proposal → pass vote → warp past hold-up → execute → assert vault lamports moved exactly per innerIxs.
- tamper attempt after sign-off fails (INV-9) **(verify state machine)**.
- CU per executed tx < limit with margin; oversized inner sets split correctly.
- unwrap(wrap(x)) == x.

### 6.5 `keeper`

**Contract**

- Per tick, per managed vault: build + send collect ix(s) for curve and AMM venues; record `SweepResult` with the **gross** amount (INV-8 — no skim exists here).
- Idempotent on zero accrued fees; retry/backoff; alert on repeated failure; handles AMM wSOL/USDC ATA venue and optional `transfer_creator_fees_to_pump_v2` consolidation post-graduation **(verify)**.

**Tests**

- vault balance delta == gross accrued (within fee/rounding tolerance).
- keeper never appears as creator-signer (INV-2); idempotent second run.
- AMM venue handling; checked-math fuzz near u64 bounds (INV-6).

### 6.6 `backend` — Orchestrator

**Contract**

- `launch(params)` executes the Section 2 sequence with idempotency keys per step; on partial failure returns a resumable state object; never leaves a token whose creator ≠ the predicted vault (the creator is set in the same ix as creation, so the dangerous partial states are only pre-launch — assert anyway).
- Collects `PROTOCOL_LAUNCH_FEE_LAMPORTS` from launcher to protocol treasury inside the launch flow.
- Persists simulation/decoded artifacts (12.4) keyed by proposal + instruction-set hash.

**Tests**

- INV-1, INV-5, predictedPdasMatched all true on `LaunchResult`.
- launch fee received by protocol treasury (balance assert).
- injected failure after token creation → resume completes realm setup; second resume is a no-op.
- mode == cypherpunk → no council accounts; mode == council → veto path live (cross-check 6.3).

### 6.7 `app` — Frontend

**Contract**

- **Mode selection page**: side-by-side mode comparison; Cypherpunk requires one explicit confirmation (“no veto, irreversible”); Sovereign requires two (“no veto + no timelock floor; this DAO can drain itself the moment a vote passes”).
- Launch form enforces tier/mode matrix floors client-side (server re-validates).
- Proposal view renders: decoded summary, simulation results, red flags (12.4), hold-up countdown, veto status (Council), and the instruction-set hash with a “verified against chain” badge.
- Dashboard: vault balance, sweep history, lockup-weighted vote power.

**Tests** (component + Playwright e2e)

- sub-floor params rejected; sovereign double-confirm enforced; hash badge turns red on artifact/chain mismatch (simulated).
- execute button disabled until hold-up elapsed.

### 6.8 Fixed action menu (safe presets; sole admissible set in Guarded @ Stage 3)

|Action            |Params                                  |Implementation & guarantee                                                                                                                                                                                                 |
|------------------|----------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
|`buyback`         |maxSpendLamports, minTokensOut          |pre-graduation: pump curve buy; post: own PumpSwap pool swap **(verify pool ix)**. Spends ≤ max; reverts if out < min                                                                                                      |
|`provideLiquidity`|amounts, minLp                          |deposit into the token’s own canonical pool only **(verify)**                                                                                                                                                              |
|`distribute`      |snapshotSlot, totalLamports, claimWindow|Merkle distributor (audited Jito/Saber lineage program **(verify deployed ID)**): backend snapshots holders at slot (RPC/DAS), builds tree; proposal funds distributor + sets root; unclaimed clawback → vault after window|
|`grant`           |recipient, amount, memo                 |single transfer ≤ vault balance                                                                                                                                                                                            |
|`burn`            |amount                                  |burns treasury-held tokens only                                                                                                                                                                                            |
|`setParam`        |paramId, value                          |whitelisted params only, within tier floors and ratchet direction                                                                                                                                                          |

Each action: its own builder + test asserting bounds and that no accounts outside the declared set are touched. `distribute` additionally: Σ(claims) ≤ funded; clawback returns remainder; double-claim impossible.

### 6.9 Stage 3 programs

- **launch-coordinator**: atomic launch (derive vault → CPI pump create → init realm) AND programmatic fee custody: coordinator PDA as creator, with an on-chain immutable split (protocol bps → protocol treasury, remainder → DAO vault) executed on every collect. This supersedes the GATE 0c shares mechanism for new launches.
- **proposal-gate** (enables Guarded mode): realm authority held by this program; it only signs-off proposals whose instruction set ∈ the fixed menu (byte-validated builders). Also enforces INV-11 ratchet structurally (mode transitions one-way).
- Anchor safety throughout: `overflow-checks = true`, typed `Program<'info,T>`, no CPI to user-supplied programs, no user-signer forwarding, `reload()` after CPIs, bump validation.
- **Tests:** single-tx launch parity with MVP assertions; gate rejects off-menu instruction byte-patterns; fuzz malformed accounts → clean revert, no partial state; split math exact under fuzz (INV-6/INV-8).

-----

## 7. Stage gates

### GATE 0a — PDA creator + permissionless collect (hard stop)

`scripts/devnet-validate-creator.ts`: Squads vault as creator on devnet pump → buy → third-party collect → **accept iff vault lamports strictly increase**. If devnet pump state is unusable, equivalent evidence on local validator with mainnet-cloned programs is acceptable; record which path was used. **On fail: STOP → Section 9 pivot.**

### GATE 0b — Token-2022 on curve (soft)

Launch + trade a transfer-fee Token-2022 mint on the curve. Pass → v2 feature unlocked. Fail → drop from scope; proceed.

### GATE 0c — Fee shares configurable at launch for a PDA creator (soft, new)

Attempt: create token (creator = vault) + set fee shares {vault: 1−bps, protocol: bps} within the launch ceremony + admin revoke. Pass → ongoing protocol revenue in MVP. Fail → MVP protocol revenue = flat launch fee only; programmatic split waits for Stage 3. Either outcome proceeds.

### GATE 1 — MVP e2e (devnet), run as a mode matrix {council, cypherpunk}

Accept iff ALL, per mode:

- INV-1..7 + INV-9..10 each have a passing assertion in the run (INV-4 veto leg applies to council only).
- Holder locks → proposes (ExecutionAdapter-wrapped SOL transfer) → quorum → hold-up elapses → executes; vault delta exact.
- Council mode: a veto during hold-up blocks execution. Cypherpunk: assert no council mint exists; the same drain-style proposal executes faithfully after 24h+ hold-up (proving code-is-law AND the exit window).
- Keeper sweep gross-correct; launch fee received; predictedPdasMatched true.
- Evidence (signatures + reports) written to GATES.md.

### GATE 2 — Hardening

Clean Sec3 X-Ray on all custom code; mode×tier property tests green (Section 5 obligation); observability live (sweeps, balances, proposal anomalies); red-team finds no capture path on simulated micro-tier in both MVP modes.

### GATE 3 — Coordinator + proposal-gate

Programs deployed to devnet; single-tx launch parity; Guarded mode live and byte-enforced; ratchet structural; external audit sign-off (Sec3/OtterSec/Neodyme) documented; bounty opened. No mainnet for any custom program before this gate.

### GATE 4 — Meteora rail + platform maturity

Same e2e matrix passes against `MeteoraDbcRail` with zero changes above the SDK layer; coordinator-custody launches default for new tokens; runbook complete.

-----

## 8. Test strategy

- **Unit:** PDA derivations, matrix resolution, fee math, wrap/unwrap round-trip. No network.
- **Integration (local validator, mainnet clones):** every fund path with balance/owner asserts; ExecutionAdapter full path; bankrun clock-warp for hold-up/lockup.
- **E2E (devnet + Playwright):** full launch→govern→execute through the real UI, both MVP modes.
- **Property:** Section 5 capture obligation across randomized economics and all shipped mode×tier combos.
- **Fuzz:** keeper + split arithmetic at u64 bounds; Stage 3 programs with malformed accounts.
- **CU budget:** measured per executed governance tx; fail test if within 15% of limit.
- **Regression:** every fixed bug pins a test.
  **Coverage law:** 100% of fund-moving and PDA-derivation paths integration-covered. UI best-effort.

-----

## 9. Fallback rail (Meteora DBC) — unchanged in role

`MeteoraDbcRail implements LaunchRail`; partner/creator fee recipient = vault PDA (INV-1 reinterpreted); curve/quote/fee-split configured per launch; DAO/keeper/governance layers untouched. The e2e matrix must pass identically.

-----

## 10. Definition of Done

A stage is Done when: tests-first all green; gate evidence in GATES.md with operator sign-off; all relevant invariants asserted in-run; no fund path without balance asserts; (Stage 3+) audit documented before mainnet; no private key ever logged/committed/manifested; no mainnet revenue/upgrade key is agent-generated; PROGRESS/DECISIONS/VERSIONS current; ops runbook updated (keeper deploy, alerts, RPC failover).
Product Done = launch → fees → holder-governed treasury with faithful execution, and no capture path at micro tier in any shipped mode — proven by the property suite, not prose.

-----

## 11. Wallet & key management (delta from v1.1 only)

Unchanged in substance: full autonomous devnet keygen/funding via `scripts/init-wallets.ts` (idempotent, manifest public-keys-only, faucet retry/backoff); secret-handling rules; the single mainnet fund-in (deployer + keeper) with operator-supplied protocol-treasury and upgrade-authority (multisig) addresses; halt-until-funded; upgrade authority never on a hot key.
**v2 clarifications:** council test keys exist only in council-mode devnet runs; no third-party API keys are required for any devnet stage (public RPC defaults — keeps the human-in-the-loop promise exact); `protocol-treasury` on devnet is agent-generated and disposable.

-----

## 12. Proposal execution model & governance modes

### 12.1 Code is law, faithfully executed

A proposal is an ordered instruction set stored on-chain in SPL Governance ProposalTransactions (wrapped by the ExecutionAdapter). What passes is what executes — byte-identical (INV-9). Modes differ only in admissible surface, delay, and whether a vetoer exists; never in fidelity of execution.

### 12.2 Modes

|Mode          |Availability         |Admissible                                      |Hold-up                  |Veto                                        |Notes                                   |
|--------------|---------------------|------------------------------------------------|-------------------------|--------------------------------------------|----------------------------------------|
|**Council**   |MVP                  |menu + arbitrary                                |tier floor               |council veto during hold-up                 |council mint structural                 |
|**Cypherpunk**|MVP                  |menu + arbitrary                                |max(24h, tier floor)     |none — structurally (no council mint exists)|terminal-leaning                        |
|**Sovereign** |MVP, double-confirmed|arbitrary                                       |configured ≥ 0 (may be 0)|none                                        |out-of-warranty by design; loudly warned|
|**Guarded**   |Stage 3              |fixed menu ONLY (byte-enforced by proposal-gate)|tier floor (strictest)   |required                                    |the safety product                      |

**Ratchet (INV-11):** guarded → council → cypherpunk → sovereign, one-way. **MVP honesty caveat:** in MVP the ratchet (e.g., removing a council via SetRealmConfig **(verify)**) is enforced by governance itself — a community could in principle vote to re-add a council. Structural one-way enforcement arrives with proposal-gate at Stage 3. Documented in-product; not hidden.

### 12.3 Decode + simulate harness (all modes)

- **Storage:** simulation results and decoded summaries are off-chain artifacts (backend `ARTIFACT_STORE`), keyed by (proposal, instruction-set hash). The UI recomputes the hash from on-chain ProposalTransactions and shows a match badge; mismatch renders red and hides nothing (INV-9/10).
- **Decoder:** known-IDL instructions render human-readable; unknown → “UNKNOWN — raw data” red flag. ExecutionAdapter `unwrap` exposes inner instructions to the decoder so users see the *real* effects, not the Squads plumbing.
- **Red-flag heuristics (inform, never block outside Guarded):** transfers > X% of vault to non-whitelisted address; changes to governance config; interactions with unknown programs.
- **Tests:** artifact↔chain hash match; mismatch badge; unknown-ix flagging; sim effects ≈ executed effects within tolerance (run on a copy via bankrun).

### 12.4 Per-mode user meaning (UI copy source of truth)

- **Council:** “Anything can be proposed. A council you chose can veto during the waiting period. The waiting period always applies.”
- **Cypherpunk:** “Anything can be proposed. Nobody can veto. There is always at least a 24-hour wait between a vote passing and execution — your only protection is information and the exit window.”
- **Sovereign:** “Nobody can veto and there may be zero delay. If a malicious vote passes, funds move immediately. You accept this.”
- **Guarded (later):** “Only pre-audited action types can ever execute. The treasury cannot be sent to an arbitrary address even by a winning vote.”

-----

## 13. Agent execution checklist (work top to bottom; tick in PROGRESS.md)

**Stage 0**

1. Scaffold repo/workspaces/CI; pin versions → VERSIONS.md.
1. `scripts/init-wallets.ts` + tests green.
1. Verify-and-record (DECISIONS.md): all (verify) items in Sections 1, 6 — IDLs, PDA seeds, spl-gov veto config, state-machine immutability, merkle distributor program ID, PumpSwap pool ixs.
1. GATE 0a script → evidence → STOP for sign-off. Then 0b, 0c (soft).

**Stage 1**
5. sdk: types → PumpFunRail → Treasury → Governance → ExecutionAdapter (tests first, in that order).
6. keeper; backend orchestrator; menu action builders (6.8).
7. app: mode selection → launch flow → proposal/dashboard views.
8. GATE 1 mode matrix on devnet → GATES.md → sign-off.

**Stage 2**
9. Property + fuzz + CU suites; Sec3 scan; observability; red-team report → GATE 2.

**Stage 3**
10. launch-coordinator + proposal-gate (tests first); Guarded mode; structural ratchet; audit + bounty → GATE 3.

**Stage 4**
11. MeteoraDbcRail + rail-matrix e2e; coordinator-custody default; runbook → GATE 4.

**Mainnet transition (only after operator approval):** funding request (two pubkeys) → halt → resume on funds → deploy with operator-supplied upgrade authority/treasury → mainnet smoke test → done.