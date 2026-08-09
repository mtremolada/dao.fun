# GATES.md — gate evidence & operator sign-off

## GATE 0a — PDA creator + permissionless collect (HARD STOP)

**Status: PASS — executed on MAINNET, 2026-06-11** (operator override
D-008: the devnet faucet was IP-rate-limited in this environment; the
operator funded a real run with ~$4.60 USDC, swapped gasless to 0.0725 SOL
via Jupiter Ultra; all liquid funds were swept back after the run —
0.0593 SOL returned to the operator's wallet).

Path used: mainnet-beta — same program IDs as devnet, production state;
stronger evidence than the spec's devnet/local-clone alternatives.

| Item | Value |
|---|---|
| mint | `E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC` |
| Squads multisig | `5572XY2dwdq2srxLBRgDeVzUkNxuGcBafn9xqStko8q8` |
| vault PDA (pump creator) | `3qnu5xeFW2vwHPK116PccxwuBTqvQqfikp73tvVR4uJA` |
| predicted native treasury (sole member, asserted on-chain) | `FmGNFAZmRdNYnf9eGwcXysZCPM7PJDMUiT2W94kHLsuo` |

Transactions (mainnet):

- multisig-create: `65XXqYszYCWidRHujrW3jRs8aZZmyTRbmKxPittemvz2ZwVere9uM7gLDS5pJhraDZNR69mfhnYXvVpYDxXKVgRM`
- rent-prefund-vaults: `2TBiz2sFgs24G1w9vmQQGMVdoBhcpTY7puAwShgrfTW5BKxa8Egmif4vR8UP2vbnn6Bp1xUC9o4V7Ur5gGsYpzQD`
- create-v2-and-dev-buy (creator = vault PDA): `2nHuT8LacbvqBveW4qegMxwRPJLZSBfWpk2xJsC5UbYmDDnstKiMKnmzth1fqZqA8hCTEgM23HZLsLXSN6dr7JsF`
- third-party-buy: `5YtVtcprYyBq2MzzXsUcYscUEKBnkMcg5bFu38mVSZ9ZJuN79B1cwPZL8SzGd5D6QQfBhGvX1W8Svn4njRdV6Qfk`
- permissionless-collect (keeper as fee-payer only; INV-2 signer-set asserted pre-send): `5ipd9HVbwDc4YtWhbujMsNviUJiDtmMqiZiRKhbEA3FLUEaF7VAacA3MjmCnKXR34bsbesQgMJRhHEAqzxRCgHMz`

**Accept criterion:** Squads vault lamports strictly increase after a
keeper-paid, creator-signature-free collect.
**Result:** `890880 -> 7271603` (+6,380,723 lamports of creator fees). PASS.

Sole-member prediction also asserted on-chain post-creation: multisig
members == [predicted native-treasury PDA], threshold == 1 (INV-7 shape).

Full machine evidence: `.gate-evidence/gate-0a-mainnet.json`.

Notes:
1. The buyer leg of the first attempt failed Solana's rent floor (the fee
   payer would have closed below the ~0.0009 SOL rent-exempt minimum) and
   was resumed with a smaller buy. Engineering consequence recorded in
   DECISIONS.md D-009 (keeper/orchestrator must maintain rent floors).
2. The 0.00727 SOL collected into the test vault is controlled by the
   not-yet-created realm for this mint (advance-derivation works both
   ways); recoverable only by standing up the governance chain. Treated as
   sunk (~$0.47).
3. Cleanup: test tokens sold back to the curve, token + USDC ATAs closed
   (rent reclaimed), all three role wallets swept to the operator wallet
   `2aJKQetcRJDVcbXikYUUuPZByypPV46LWdCSm48sWzYk`.

Operator sign-off: **APPROVED** — Matt (operator), 2026-06-11, recorded
from the operator's session instruction (run was operator-funded and
operator-directed).

## GATE 0b — Token-2022 on curve (soft) — DETERMINED

Run 2026-06-11 against the REAL pump binaries in bankrun
(`tests/gate0b-token2022.integration.test.ts`, part of
`pnpm test:integration`). Two halves:

- **Plain Token-2022 on the curve: PASS** (and now hermetic, not just the
  GATE 0a live evidence): `create_v2` with a PDA creator produced a
  Token-2022 mint that was BOUGHT and fully SOLD BACK on the curve; the
  creator vault accrued real fees from the buy (INV-8 surface). The
  extension set pump initializes was decoded from the live mint — no
  TransferFeeConfig.
- **Transfer-fee extension: FAIL — drop from scope** (the gate's fail
  branch): pump creates and initializes the mint INSIDE `create_v2`, so
  a transfer-fee mint can only exist if pre-initialized — and a
  pre-existing mint account is refused by `create_v2` (verified on the
  real binary: the launch fails, no bonding curve is created). Transfer
  fees are structurally impossible on the pump curve; nothing to build.

Operational note (D-009 again): buys/sells make small lamport transfers
to fee-recipient accounts — the test, like GATE 0a's
rent-prefund-vaults step, prefunds missing writable accounts to the rent
floor. The keeper/orchestrator rent-floor rule generalizes to every
account that receives fee crumbs.

Operator sign-off: **APPROVED** — Matt (operator), 2026-06-11, recorded
from the operator's session instruction.

## GATE 0c — Fee shares at launch for PDA creator (soft) — DETERMINED

Run 2026-06-11 against the REAL pump + PumpFees mainnet binaries in
bankrun (`tests/gate0c-fee-sharing.integration.test.ts`, part of
`pnpm test:integration`). Split verdict, exactly as risk flag D-007
predicted:

- **At-launch config: FAIL (hard on-chain constraint).** A real
  `create_v2` token was launched with creator == the DAO's Squads vault
  PDA (INV-1 verified by decoding the live bonding curve). The launcher's
  `createFeeSharingConfig` is refused by the deployed PumpFees binary
  with `NotAuthorized` (6016, create_fee_sharing_config.rs): the
  instruction's ONLY signer is the payer, and the payer must be the coin
  creator. A PDA cannot sign a plain launch transaction, so the spec's
  at-launch shares mechanism is impossible. **MVP protocol revenue =
  flat launch fee only** (the spec's designated fallback); the Stage 3
  coordinator supersedes this for programmatic splits.
- **DAO-governed fee sharing post-launch: PASS.** The SAME instructions
  succeed when the vault PDA invoke_signs through the governance-executed
  Squads chain: one ATOMIC vault transaction carrying
  `createFeeSharingConfig` + `updateFeeShares {vault 90%, protocol 10%}`
  was proposed (buffered ExecutionAdapter chain), voted, finalized,
  hold-up-warped, and executed against the real binaries; the resulting
  on-chain SharingConfig decodes to exactly the voted split. Fee sharing
  is therefore a DAO action (a future 6.8 menu item), not a launch-time
  platform feature.

Machinery findings (D-019): governance InsertTransaction size limits,
buffered Squads wrapping (`wrapBuffered`), the six-zero-byte
`vaultTransactionCreateFromBuffer` placeholder, v0+ALT packing for
account-heavy execute inserts, and the 400k CU floor for stacked
executes.

`buildFeeSharesAtLaunchIxs` stays gated (`FeatureUnavailable`) — the
at-launch path is closed by the program itself.

Operator sign-off: **APPROVED** — Matt (operator), 2026-06-11, recorded
from the operator's session instruction.

## GATE 1 — mode matrix e2e (sovereign leg PASS on mainnet; council/cypherpunk/VSR legs PASS on real binaries)

Operator-funded mainnet runs (D-008 regime), 2026-06-11. Devnet remains
faucet-blocked; operator directed mainnet runs instead. Smoke deviations
recorded in D-014; architecture findings in D-013/D-015/D-016.

### Phase 1 — DAO over the real pump mint (partial)

DAO stood up for the GATE 0a mint `E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC`:

- realm `3Cay6Bb9PWJBtaphqY4cgxwYMybG58Bf2mfcu9bDVgBJ` == advance-derived
- governance `6JiBFCrw2Q79Yu2wViNJCDMvAXHQuvvmHU7dy85uhLz5` == advance-derived
- native treasury `FmGNFAZmRdNYnf9eGwcXysZCPM7PJDMUiT2W94kHLsuo` == the
  GATE 0a Squads vault's sole member, created BEFORE the realm existed —
  the advance-derivation custody rule (INV-7) verified end-to-end on-chain
- realm authority transferred to the governance PDA (no platform key)
- Token-2022 community deposits live (D-013 caveat: mint appended)

The proposal leg of THIS realm stays blocked at the 0.102 SOL refundable
security deposit (its config predates the D-015 fix); resumable later.

Machine evidence: `.gate-evidence/gate1-sovereign-mainnet.json`.

### Phase 2 — full sovereign proposal lifecycle, executed (PASS)

Fresh DAO under the fixed config (production sovereign/micro params from
the matrix; synthetic Token-2022 mint `3pEjEhJoKWEXb5aqKYN7pqG5GKFQL997Ndu1pUMn6Aq2`,
supply sized so FULL_SUPPLY_FRACTION max vote weight is production-true;
only deviation: 1h baseVotingTime, the program minimum — D-014):

- INV-5: mint + freeze authorities verified null after mint
- INV-7: Squads multisig `2hEbJ9x64sY9jTdpyr9M3aUwcSvNJ3ULsc1X241fYa8L` /
  vault `8Z4PfwCARrz3DbJQpwy9vhmYz3xvokn9tZN1vsHq1kj9` created with the
  advance-derived native treasury `B6XaWx7GJe2wGQameC5T914DcwV9Y6DL4P9SgK6c87r8`
  as sole member, before the realm existed
- realm `GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR` == advance-derived;
  realm authority == governance PDA (asserted on-chain)
- D-015 verified live: proposal creation required NO security deposit
- full lifecycle on-chain: create proposal `A99hKkvG...` -> insert 4 wrapped
  Squads ixs -> sign-off -> cast vote -> finalize after the 1h window
  (state Succeeded) -> execute all 4 ProposalTransactions
- INV-9 verified the strong way: wrapped ixs were re-read FROM CHAIN,
  unwrapped, and hashed — `76962352e6c2b1cc...` == published artifact hash
- INV-3 (holdUp 0) — execution allowed immediately after Succeeded
- custody chain moved real lamports: Squads vault 890,880 -> 0, swept to
  the deployer via governance-executed VaultTransactionCreate ->
  ProposalCreate -> Approve -> Execute (native treasury as sole approver)
- D-016 found live: the native treasury pays Squads' account rent during
  execution (2,429,040 + 2,046,240 lamports here) — launch flow must
  prefund execution rent (see DECISIONS.md)
- cleanup: vote relinquished, deposit withdrawn (mint appended), synthetic
  tokens burned + ATA closed, buyer swept to exactly 0

Machine evidence: `.gate-evidence/gate1-sovereign-p2-mainnet.json`.

### Council / cypherpunk / VSR legs — real mainnet binaries in bankrun (PASS)

`tests/gate1-matrix.integration.test.ts` (`pnpm test:integration`), run
2026-06-11 against the DEPLOYED program binaries dumped from mainnet the
same day (`scripts/dump-mainnet-programs.ts` → `tests/fixtures/*.so`:
spl_governance 1,319,856 B, squads_v4 1,470,416 B, vsr 1,301,200 B,
token_2022 1,382,016 B, plus the live Squads ProgramConfig account).
Production micro-tier params throughout, including the 3-day voting
window and the 72h hold-up — bankrun clock-warp covers what a live
cluster cannot. 4/4 tests PASS; the suite runs hermetically in CI
(`integration` job, no network).

- **Council leg (INV-4 + INV-3 + INV-9)**: community YES + council veto
  (1-member council, 50% veto threshold, D-011 config) → proposal state
  `Vetoed`; execution refused even after every timer has elapsed, vault
  untouched. A second, non-vetoed proposal on the same DAO finalizes to
  `Succeeded`, is refused before the 72h hold-up
  (`GOVERNANCE-ERROR: Can't execute transaction within its hold up time`),
  then executes the full 4-step Squads chain after the warp — vault
  890,880 → 0, recipient +890,880. Both proposals' instruction sets
  re-read from chain state, unwrapped, and hash-matched (INV-9).
- **Cypherpunk leg (structural no-veto + INV-3 + INV-9)**: realm built
  with NO council accounts (`Realm.config.councilMint` undefined — veto
  structurally impossible, spec 12.2); 72h hold-up refusal, then clean
  custody-chain execution; proposal ends `Completed`.
- **VSR leg (spec 6.3 lockup weighting under clock warp)**: baseline-0
  registrar (production config): an UNLOCKED deposit carries zero voter
  weight and proposal creation is refused; a 365-day cliff lockup (the
  micro saturation horizon) carries full weight and the proposal goes
  through; warping half the horizon decays the weight to ~half; past the
  cliff it is zero. First execution of the VSR path against the deployed
  binary.
- **D-013 re-verified with clean evidence**: the original mainnet D-013
  experiment ran with a wrong registrar seed order (D-018), confounding
  its failure. With correct seeds, `create_registrar` rejects a
  Token-2022 community mint on the MINT's owner
  (`AccountOwnedByWrongProgram`), not on seeds — the no-addin-at-MVP
  architecture stands.

The suite found and fixed two real sdk bugs before any council-mode or
VSR launch could hit them live (D-018): council-mint creation must
precede createRealm, and the VSR registrar PDA seed order is
`[realm, "registrar", mint]`.

Remaining for GATE 1 full PASS: nothing technical — operator sign-off.

Operator sign-off (sovereign leg): **APPROVED** — Matt (operator),
2026-06-11, recorded from the operator's session instruction.
Operator sign-off (council/cypherpunk/VSR legs): **APPROVED** — Matt
(operator), 2026-06-11, recorded from the operator's session instruction.

With these sign-offs, GATE 0a/0b/0c and GATE 1 are formally CLOSED
(Definition of Done, spec Section 10): Stage 0 and Stage 1 are Done.

## GATE 2 — Hardening (Stage 2) — technical legs determined 2026-06-12

Acceptance criteria from the spec, leg by leg:

### (a) "Clean Sec3 X-Ray on all custom code"

**Determined: vacuously satisfied — and recorded, not hidden.** Sec3
X-Ray audits Solana PROGRAMS (Rust). The MVP deliberately ships ZERO
custom on-chain code: every on-chain component is an audited, deployed
binary (spl-governance, Squads v4, VSR, pump stack, the IMMUTABLE Jito
merkle distributor — D-024), pinned by ID in VERSIONS.md and by dumped
fixtures in tests/. The obligation RE-ARMS at Stage 3 the moment
launch-coordinator/proposal-gate exist (GATE 3 already requires the
external audit). Supplementary, for the off-chain TS surface:
`pnpm audit --prod` (2026-06-12) — bn.js infinite-loop advisory FIXED by
bumping the pin 5.2.2 -> 5.2.3 (all 221 unit + 20 integration tests green
after); residual findings dispositioned in REDTEAM.md §5.4
(bigint-buffer: no patch exists ecosystem-wide, native path not loaded,
fixed-width inputs; postcss/uuid: build-time / non-fund paths).

### (b) "mode×tier property tests green (Section 5 obligation)"

**PASS** — `packages/sdk/test/property-capture.test.ts` (fast-check
4.5.3, 500+ randomized runs per property over the REAL
resolveGovernanceParams and the VSR weight formula the GATE 1 leg
verified on-chain):

- unlocked weight == 0 for any amount (the flash-capture entry gate);
- Beanstalk impossibility: positive time-to-drain in every shipped
  combo, for every voting window a setParam vote could reach;
- the hit-and-run dichotomy: for ANY budget, EITHER the attacker's
  lockup outlives the drain (always, at the shipped 3-day window) OR the
  drain itself took >= saturation×quorum% (>= 9 days, worst combo) of
  public notice;
- sovereign hold-up-0 reachable ONLY via the explicit double-confirmed
  parameter (out-of-warranty by design, spec 12.2).

Plus the fuzz suite `fuzz-bounds.test.ts` (u64-bound share math, merkle
proof soundness under random share sets, grant bounds, wrap/unwrap
roundtrip). The fuzz suite FOUND one real bug: Squads message-format
privilege normalization made conflicting-flag inner sets publish an
artifact hash that could never match the chain recomputation (permanent
false red badge). Fixed in buildProposeIxs — the published hash is now
computed from the round-tripped effective set, equal to the chain-side
hash BY CONSTRUCTION (D-027; regression-pinned).

CU budget (Section 8: "fail test if within 15% of limit") — **PASS**,
`tests/cu-budget.integration.test.ts` against the real binaries, 400k CU
limit per executed governance tx (the production setting): custody chain
46,603 / 35,813 / 28,746 / 43,368; direct leg (setParam) 29,701;
distribute chain 53,621 / 34,056 / 28,489 / 147,519. Worst case 36.9% of
the limit — every tx clears the 85% ceiling with margin.

### (c) "observability live (sweeps, balances, proposal anomalies)"

**PASS** — keeper: `KeeperMonitor` + `runMonitoredTick`
(packages/keeper/src/observability.ts; 5 tests): structured sweep
events, bigint-exact swept-lamports counters, per-vault balance gauges,
and consecutive-failure escalation firing exactly at the threshold
crossing (spec 6.5 "alert on repeated failure"), reset on recovery,
JSON-able snapshot() for scraping. Backend: `detectProposalAnomalies`
(6 tests) — hash-mismatch (INV-9), missing-artifact-hash (INV-10),
zero-hold-up, no-instructions — surfaced on GET /chain/proposals/:id so
every UI consumer gets the flags computed server-side from chain state.

### (d) "red-team finds no capture path on simulated micro-tier in both MVP modes"

**PASS** — REDTEAM.md (2026-06-12): every attack either reproduced
against the real binaries and refused (flash capture, veto bypass,
bait-and-switch, claim forgery, raw vault theft, keeper escalation), or
excluded by the machine-checked property suite (slow capture dichotomy),
or dispositioned as a residual platform risk with mitigation (sovereign-0
out-of-warranty; MVP governance-level ratchet until Stage 3;
deployed-binary and RPC trust; dependency findings). No capture path
stands on micro-tier council or cypherpunk.

Suite state at determination: 221 package unit tests + 19 integration
tests (real mainnet binaries, hermetic; 3 consecutive green runs);
eslint + tsc clean.

Operator sign-off (GATE 2): **APPROVED** — Matt (operator), 2026-08-08,
by blanket delegation in session `…9Aaw` ("make the decisions and finish
the job"); recorded under that delegation. All technical legs were
determined 2026-06-12 and unchanged since.

## GATE L2 — devnet end-to-end (launchpad)

**Status: PASS — 2026-08-08.** The launchpad is live on Solana devnet: a coin
was launched on the native curve, bought to completion, and graduated into a
REAL Raydium CPMM pool with the LP burned. Not a simulation — every line below
is an on-chain account or signature anyone can verify.

| Item | Value |
|---|---|
| Program | `DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V` (deploy slot 482171857, 419,912 bytes) |
| Upgrade authority | `5xqnc7on54YYTiNKDbC5vb123q3JDuLSGF8HdQSd1f2G` (disposable devnet deployer, D-008) |
| Config | `initialize_config` `4gxNg75nN1ZA1NAVwLqX6RVr4s79rY2H8CeHhR35uFJTUGTbiCDDq1eKRUd5827rkqXQqujm71ZkCrnJPGPSBfvF` |
| CPMM pinned (immutable) | `DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb` / amm config `5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy` |
| Coin mint | `8PnhcD5R8inK9YbcS2GYTg63n6LD3FY3xxD47RaB1s5K` |
| create_coin | `sADA4q7tAtDJeQxu1JBcExQzZ6QUw1jFGfo6N8BQfGXGBJntbkD4kiZ5u1bHamABaegGLsZhCzNcKSEA26HyNoA` |
| buy → complete | `5g5Y7UM7qT4HjNY83ej8hxG1ACSN3QRy3c5AM9SMDWqqM93K7bg7vZvs9vWmi1aSWJHTxXQoM2U59zGT8uqSdi3e` |
| migrate | `2MGx32ksckfyEYvRzNJDjSpfBCT5zz8AshksWnQNCnWT5RxkpK2z9psvT968hUrz1NEFDB6ECBzNFDVnFUNgRpZV` |
| Raydium pool | `7Xi9ijr7mZS6YL1fmwfscSuEQyQ9kZD9W3PzbNob9Bof` (owner = devnet CPMM) |
| Frontend | https://mtremolada.github.io/dao.fun/ (Pages run 31274586319, all routes 200) |

**Accept criteria / Result**

- Curve completes at the scaled devnet profile → `complete = true`, raise
  **2,833,511,969 lamports**, matching `raiseAtCompletion(DEVNET_SCALED)` to
  the lamport.
- Graduation seeds a real pool → pool account exists and is **owned by the
  devnet CPMM program**, not by us.
- **INV-LP-BURNED** → `lp_mint.supply == 0` after migrate (Raydium never mints
  the 100 units it withholds, so a fully burned pool reads zero).
- Migration is permissionless → cranked by a plain fee-payer with no authority.

**Finding fixed during this gate (D-036 addendum).** `Program<'info,
RaydiumCpmm>` pins the CPI crate's MAINNET address at the type level, so
`initialize_config` rejected devnet's CPMM (anchor 3008). The real
INV-CPI-PINNED guarantee is the `address = config.cpmm_program` equality
enforced at migrate, so the account type is now `UncheckedAccount` with an
`executable` constraint at init: one binary serves every cluster with the
security property unchanged. Re-proven against the mainnet binaries (11/11).

Operator sign-off: **APPROVED** — Matt (operator), 2026-08-08, by the
same blanket delegation as GATE 2 above.

## GATE L3 — the fee model (protocol vault, graduated fees) — EVIDENCE COMPLETE, canary pending

Scope: PLAN-FEE-MODEL.md — the coin's own protocol fees pay for its
graduation, the LP is locked rather than burned where a locker exists, and
the resulting stream splits 90/10 in the creator's favour after the
graduation cost is repaid. D-049 (locker verification), D-050 (the model).

**Layer 1 — bankrun against the REAL mainnet binaries.** All green.

| Evidence | What it proves |
|---|---|
| `launchpad-lock-verify` (8) | Raydium's locker interface on the DEPLOYED binary: discriminators, seeds, both account orders, recipients UNCONSTRAINED, fee key is the SOLE collect authority, a PDA may both hold it and `invoke_signed` the collect, `fee_nft_mint` accepts a PDA, no unlock/withdraw/close entrypoint exists, 23,328,400 lamports + 166,769/103,408 CU |
| `launchpad-graduated-lock` (5) | OUR program driving it end to end: burn branch when no locker is configured, lock refused while it is not, LP locked to a PDA-owned fee key paid by the coin's own vault (cranker out exactly 5,000 lamports), the coin side paid 100% to the creator, the SOL side repaying the graduation exactly and never over, then the 20/80 split to the lamport, and graduation into the fee tier the CONFIG names rather than the cluster default |
| `launchpad-curve` (6) | The whole raise reaches the pool — the protocol vault covers the overhead |
| `launchpad-build` (6) | Config stays 277 bytes with the new fields carved out of `reserved`, so already-deployed configs still deserialize; the tier can only ever be a Raydium-owned account |
| `pump-migration-economics` (1) | The competitive baseline, measured rather than quoted |
| `app/test/graduated` (7) + `e2e/profile` (3) + `e2e/coin` | The SURFACE cannot lie about which branch a coin took: a missing `["graduated", mint]` record renders as BURNED, never as a zeroed fee stream, and the recovery bar is framed as repaying the graduation rather than as fees earned — because until it clears the creator really does receive only the token side |

**Layer 2 — devnet, 2026-08-09.** Program upgraded, config pointed at the 1%
tier. Coin `42io3su15PAvmmjsNqVbPMKcaeMzjCNDzF4nf1GNCDB6`, pool
`ER5ujesyLafk21ZuQ425FtKN1sjJKkg2i9GVcLTYa2rd`. create → buy → sell →
buy-out → migrate → collect_protocol_fee → collect_creator_fee, all on
chain. The RAISE-FALLBACK path was exercised for real: the vault paid
0.023987 and the raise covered 0.168169, summing to the 0.192156 overhead
exactly. All 7 pre-upgrade curve accounts still decode.

**Layer 2b — the live deployment, audited rather than assumed (2026-08-09,
D-052).** `scripts/devnet-audit.ts` reads the chain and re-checks the
invariants the suite asserts in bankrun: the deployed binary is byte-identical
to `tests/fixtures/launchpad_curve.so.gz` (prefix compare — `solana program
dump` returns the allocated length, so the 9,904-byte zero tail is expected);
config is still 277 bytes at the 1% devnet tier with `lockProgram` unset; every
curve sits at its derived PDA carrying the 1.00% split; every migrated coin
points at a real Raydium pool whose **LP mint supply is ZERO**, which is the
strongest form of the burn guarantee — not "the LP is held somewhere safe" but
"no LP exists, so no withdraw is possible". It found two live defects (legacy
coins unbuyable; the app pointing at an undeployed program id), both fixed and
re-verified. `scripts/devnet-smoke.ts` then drove create → buy → sell →
collect_creator_fee → collect_protocol_fee against the freshly deployed
binary, checking lamports against the SDK's quote math: all green, including
the negative (a pre-graduation protocol sweep is refused).

**Layer 2c — a FRESH graduation on the hardened binary (2026-08-09, D-052).**
The three earlier graduations all predate the redeploy, so `devnet-smoke.ts
--graduate` took a new coin all the way through on the current program:
`5r9Tznj5VDSXZ9orJPBnWMHuDQXKTix3j1QxUUEGTnHu`, pool
`DEXWiVcQPqH3LAdRkpYsRSE97BgL3Vd71SmRgfp1itvk`, migrate `mSKdwSXa…`. The curve
completed at 2.833511973 SOL, drained to zero, and the pool graduated into the
tier the CONFIG names (`EsTevfac…`, the 1% devnet tier) rather than the cluster
default — the regression that bit the first live run. LP mint supply ZERO.
No `["graduated", mint]` record, i.e. the burn branch devnet must take. The
protocol sweep, refused before graduation, is ALLOWED after it (`NA8AB5e3…`) —
the reserve it was protecting has been spent.

The overhead reconciles to the lamport against `create_pool_fee` read from the
live tier plus `CPMM_RENT_LAMPORTS`:

```
overhead            0.192156720
  from raise        0.172183522   (observed: raise - pool SOL)
  from vault gross  0.019973198
  vault net change  0.013855358   (observed)
  => refund         0.006117840   (migrate returns unspent overhead)
raise + vault == overhead   ✓
```

That refund is why the vault's NET change looks smaller than its contribution;
the script now reports both rather than a net figure labelled "overhead".

**Layer 3 — mainnet canary: NOT DONE, and it is the only thing that can
prove the lock path live.** Raydium's locker is absent from devnet and
hard-codes the mainnet CPMM id, so no amount of devnet work substitutes.
Requires one real launch and real SOL — operator go/no-go.

Sign-off: ______________________  date: __________

## GATE L5 — the guarded front door, LIVE on devnet (2026-08-09) — PASSED

Scope: the proposal-gate deployed to a real cluster and driven by the
PRODUCTION ceremony, not a simulator. D-042 (the design), D-053 (this run).

**Program.** `4UioBmH3WkwYbLN6tumLGrUpXGMwFwcaxt1jbUcZE7Cy`, deployed
2026-08-09 (`3RXXk38DTPzD…`), upgrade authority the deployer. The deployed
bytes are byte-identical to `tests/fixtures/proposal_gate.so.gz` — the exact
binary the gate suites load — with no padding at all (298,040 bytes both).

**First, the thing that would have invalidated the run.** Devnet's
`GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw` is **spl-governance 3.1.2**
(1,195,568 bytes); mainnet's is the **3.1.4** fork (1,319,856). Same address,
different program — the D-031/D-032 trap wearing a different hat. Squads
differs too, binary AND on-chain ProgramConfig (a different treasury, which
`multisig_create_v2` validates). `tests/devnet-governance-parity` pins all of
this and re-runs the load-bearing assertions against the DEVNET binaries in
bankrun BEFORE any SOL was spent: the u64::MAX sentinel disables authorship on
3.1.2 exactly as on 3.1.4, and the full guarded ceremony lands. Only then was
the live run worth doing.

**The live run** (`scripts/devnet-guarded-run.ts`, all checks passed):

| Evidence | Signature / value |
|---|---|
| realm derived in advance matches what the ceremony built | `xds5UFYGFK6SoeBdKgjaWtYdfDwpFmawXaKu1YA3pxL` |
| ceremony in 3 txs: council mint → realm → governance | `2doiVtz7…`, `5iDhgxcu…`, `hNtNx38T…` |
| gate account: bound to the realm, names the community mint, GUARDED mode, full 8-program menu | — |
| the gate's council record holds **exactly one** council token | weight `1` |
| **a holder of the ENTIRE community supply is REFUSED** | `GOVERNANCE-ERROR: Voter weight threshold disabled` |
| anyone may author THROUGH the gate: propose → insert → sign off | `mvz4NZxp…`, `zRVuZv3v…`, `5uGuvDhq…` |
| the community votes on it — the electorate is the COMMUNITY mint | `2czakuAA…`, proposal `vfwHWftREkcTUGiqRdaMhCVEFB1tU6LpJvKHg4F6Wy3` |

**What this does NOT prove, stated plainly.** It is 3.1.2, not the 3.1.4 fork
production uses — the parity suite is what carries that across, and bankrun
against the mainnet binary remains the primary evidence.

**Addendum (2026-08-09, D-057) — the lifecycle is now proven to the end.**

The run above stops at a cast vote because production params are a 3-day
window and a 72-hour hold-up, and a live cluster's clock cannot be warped. So
finalize and execute — the legs where the gate hands control back to ordinary
governance — were untested on a real cluster. `devnet-guarded-run.ts --fast`
closes that by running the SAME production ceremony against a governance whose
window and hold-up are short, and driving it to `Completed`.

Only two numbers differ, and they are governance CONFIG, not gate logic: every
account, builder, CPI and the deployed gate binary are the production ones.
The window is ONE HOUR because `withCreateGovernance` refuses anything shorter
("baseVotingTime should be at least 1 hour"); hand-building the instruction
would have bought a faster run at the price of no longer exercising
`buildCreateDaoIxs`, which is the whole reason to run this live.

| Evidence | Signature / value |
|---|---|
| realm / governance / treasury | `5U9Mwwbgxh9Q7XB9Sdq9HebVin2FD7NMRqy38yvGbZ2U` / `7kKiqpaEBQa7dU75ncHW4m9Ecw1fmh5xzhAcEdsTUwE` / `9arrKTJLpUZwUnjTKZhsm576gdW66m3i7LtVq22MS8n8` |
| ceremony in 3 txs | `3Sk1v1BG…`, `2duQvqfo…`, `GPYve5h9…` |
| gate holds exactly one council token; full 8-program menu | weight `1` |
| a holder of the ENTIRE supply is REFUSED | `GOVERNANCE-ERROR: Voter weight threshold disabled` |
| anyone authors THROUGH the gate: propose → insert → sign off | `QoxSdozW…`, `65PgH3Py…`, `25RpgpSw…` |
| the community votes; proposal `9P7SDER3fJZHNo7RW87fZcv7WQmQDJsJc1y9kJCzSHYz` | `EUvr45AE…` |
| **finalize** moves Voting → Succeeded | `2AmiVERc…` |
| **execution INSIDE the hold-up is REFUSED** | `GOVERNANCE-ERROR: Can't execute transaction within its hold up time` |
| **execute** after the hold-up → `Completed` | `661SMowN…` |
| **the DAO treasury actually paid out** | 20,890,880 → 20,889,880 = exactly the 1,000 lamports the proposal named |

Two choices in that run are load-bearing. The hold-up is short but **non-zero**
and the run attempts an execution inside it and REQUIRES the refusal — a
hold-up that is configured and not enforced looks identical on a passing run,
and trying it is the only way to tell. And the final assertion is on the
treasury's LAMPORTS, not the proposal's state: a proposal that reaches
`Completed` without moving the money it promised passes every state check and
is still broken.

The advance logic lives in `scripts/lib/gov-advance.ts`, shared with
`devnet-guarded-advance.ts`, so this run and the production-params proposal
(`vfwHWftREkcTUGiqRdaMhCVEFB1tU6LpJvKHg4F6Wy3`, finalizable ~2026-08-12) drive
the SAME code. A fast run proving a different code path would have proved
nothing about the slow one. That proposal is LAUNCH.md L-90 and remains open —
it confirms the same lifecycle at production timings.

Sign-off: ______________________  date: __________
