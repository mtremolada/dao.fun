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
