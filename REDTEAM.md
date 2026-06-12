# REDTEAM.md — Stage 2 capture-path analysis (GATE 2)

Scope per the gate: "red-team finds no capture path on simulated
micro-tier in both MVP modes" (council, cypherpunk). Method: every attack
below is either (a) reproduced against the REAL deployed binaries in the
bankrun suites and shown to fail, (b) excluded by a machine-checked
property over the real resolution/weight code, or (c) listed as a residual
risk with its blast radius and mitigation. Nothing here is prose-only:
each verdict cites the test or decision record that pins it.

Date: 2026-06-12. System under test: Stage 1 MVP at commit range through
the Stage 2 suites (no custom on-chain programs; deployed binaries only).

## 1. Governance capture

### 1.1 Flash capture (Beanstalk pattern: buy → vote → drain in one tx)

**Verdict: structurally impossible in shipped modes.**
- Unlocked deposits carry ZERO vote weight (VSR baseline-0) — buying
  tokens gives no voting power until they are locked. Verified on the
  deployed VSR binary: GATE 1 VSR leg (unlocked deposit cannot even
  create a proposal).
- Vote tipping is `Disabled` in every launchpad config, so a vote can
  never finalize before the full voting window elapses; execution is
  further gated by the hold-up (INV-3, refused on-chain — GATE 1
  council + cypherpunk legs, `action-setparam` suite).
- Property suite (`property-capture.test.ts`): time-to-drain
  = votingWindow + holdUp ≥ 1h + 24h in every shipped mode×tier, for any
  window a setParam vote could reach.

### 1.2 Slow capture (buy → lock → propose → drain)

**Verdict: never a hit-and-run; dichotomy machine-checked.**
For ANY attacker budget and ANY reachable voting window
(`property-capture.test.ts`, 500 randomized runs over the real
`resolveGovernanceParams` and the on-chain-verified VSR weight formula):
- reaching quorum requires locking for at least `saturation × quorum%`
  (micro: ≥ 91 days; worst shipped combo, large tier: ≥ 9 days);
- EITHER the attacker's capital is still locked when the drain executes
  (always true at the shipped 3-day window — they cannot dump before
  their own attack lands and eat the price impact with everyone else),
  OR the drain itself took ≥ saturation × quorum% of fully-public notice
  (only reachable if the DAO first voted itself an extreme voting
  window).
- In council mode the council can veto during the hold-up regardless
  (INV-4, verified on the real binary — GATE 1 council leg).
- In cypherpunk mode the protection is exactly what the UI copy says:
  information + the exit window (≥ 24h hold-up after a public vote, with
  the full voting window of notice before it).

### 1.3 Capture via parameter change (setParam as the weapon)

**Verdict: floors + ratchet-by-omission hold (D-025).**
- A passed setParam cannot lower quorum/threshold/hold-up below the tier
  floors (build-time refusal, unit-tested) and the PROGRAM enforces the
  configured hold-up on every inserted transaction
  (`action-setparam.integration.test.ts`: stale hold-up insert refused).
- The veto surface is unreachable: a cypherpunk DAO cannot grant itself
  a council, a council DAO cannot drop its veto — those fields are
  preserved verbatim by construction.
- Residual (documented, spec 12.2): mode transitions themselves are
  governance-level in MVP — e.g. a community CAN vote to lengthen its
  voting window or (via raw SetRealmConfig in an arbitrary proposal,
  outside the menu) alter realm config. The menu cannot prevent
  arbitrary proposals in MVP; byte-enforcement is Stage 3's
  proposal-gate. Until then, the decode harness (12.3) flags any
  governance-config interaction as a red flag and the artifact hash
  badge makes the payload public (INV-9/INV-10).

## 2. Execution-fidelity attacks

### 2.1 Bait-and-switch (voters see X, execution does Y)

**Verdict: refused on-chain; hash equality is by construction.**
- Instruction sets are immutable after sign-off (verified at evidence
  level: GATE 1 re-read the wrapped instructions FROM CHAIN post-vote
  and hash-matched the artifact, INV-9).
- The Stage 2 fuzz suite FOUND and closed a fidelity gap: the Squads
  message format normalizes account privileges message-wide, so a
  conflicting-flag inner set used to publish a hash that could never
  match the chain recomputation (a permanent false-positive red badge —
  noise that could train users to ignore the real signal).
  `buildProposeIxs` now hashes the round-tripped effective set; equality
  is by construction (D-027, regression-pinned).
- Undecodable instructions render as "UNKNOWN — raw data" red flags;
  anomaly detection (`detectProposalAnomalies`) flags hash mismatch,
  missing artifact hash, and zero hold-up on the API every UI consumes.

### 2.2 Direct-leg privilege escalation

**Verdict: bounded by the program's own signing rules.**
Direct legs execute with ONLY the privileges spl-governance itself
invoke_signs: the governance PDA and the native treasury. The native
treasury is the Squads vault's sole member by construction (INV-7), and
the governance PDA can only meaningfully sign for its own config. A
malicious direct leg can therefore do nothing a vault-leg proposal could
not already do — and both are hash-pinned and hold-up-gated.

## 3. Treasury / custody attacks

- **Raw vault theft**: the Squads vault is program-owned; lamports
  cannot move via SystemProgram (owner check, treasury unit tests), and
  the only member that can create/approve/execute vault transactions is
  the governance native treasury (non-member rejection tested).
- **Keeper as an attack vector**: the keeper signs only as fee payer
  (INV-2 enforced as a refusal in `sweepVault` — a collect ix demanding
  any other signer throws). Sweeps are gross-only (INV-8); a shrinking
  vault across a sweep halts the keeper (INV-6).
- **Fee-vault griefing**: collects are permissionless — anyone CAN
  trigger them, but the destination is fixed by the pump program to the
  creator vault (the DAO's). Triggering a sweep for someone is a donation
  of tx fees.

## 4. distribute-specific attacks

- **Backend lies about the snapshot**: the share list is an off-chain
  INPUT; the proposal pins the merkle root on-chain at creation (INV-9
  covers it) and the voting window is the audit window. A poisoned tree
  is visible to anyone who recomputes the root from the published share
  list (D-026 trust note).
- **Claim forgery / double claims / tampered amounts**: refused by the
  immutable on-chain verifier — proven against the REAL binary
  (`action-distribute.integration.test.ts`).
- **Version squatting** (global PDA namespace): a front-runner can only
  make `newDistributor` fail; the chained execute aborts and the funding
  never leaves the vault. Recovery: re-propose with a fresh random
  version (D-024).
- **Funds stranded in the distributor**: clawback is permissionless
  after the window and returns the remainder to the vault's WSOL ATA
  (proven on the real binary; books close exactly).

## 5. Inherited / platform risks (residual, accepted with eyes open)

1. **Sovereign hold-up 0 is out-of-warranty by design** (spec 12.2): the
   property suite treats it as excluded; the UI requires a double
   confirmation; the anomaly detector flags `zero-hold-up` on every such
   proposal. The launchpad ships it as an explicitly-labeled footgun.
2. **MVP mode ratchet is governance-level** (spec 12.2 caveat): a
   community can vote to weaken itself via arbitrary proposals outside
   the menu. Structural enforcement is Stage 3 (proposal-gate). This is
   documented in-product, not hidden.
3. **Deployed-binary trust**: the system composes audited, widely-used
   programs (spl-governance, Squads v4, VSR, pump, Jito distributor —
   the latter verified IMMUTABLE on mainnet, D-024). A vulnerability in
   any of them is inherited. Mitigation: program IDs pinned (VERSIONS),
   binaries dumped and hash-stable in fixtures, no upgrade-authority
   exposure of our own.
4. **Dependency audit** (Sec3 X-Ray is not applicable in MVP — zero
   custom on-chain programs; the obligation re-arms at Stage 3):
   `pnpm audit --prod` 2026-06-12 — bn.js infinite-loop advisory FIXED
   by bumping the pin to 5.2.3; remaining: `bigint-buffer` (high; no
   patch exists anywhere in the Solana ecosystem; native code path is
   not even loaded here — pure-JS fallback — and inputs are fixed-width
   on-chain account slices), `postcss` and `uuid` (moderate; build-time
   and non-buf-API paths inside next/jayson, not fund paths). Tracked
   for the next dependency refresh.
5. **RPC trust for snapshots/reads**: a malicious RPC could feed a wrong
   holder set or chain state. Distribution roots are publicly
   recomputable (see §4); chain reads feeding the UI carry the hash
   badge. Operators running real funds should pin a trusted RPC
   (env spec).

## Verdict

No capture path found on simulated micro-tier in either MVP mode that
defeats (a) the zero-weight-unlocked entry gate, (b) the lockup-vs-drain
dichotomy, and (c) the hold-up + veto/exit-window layer — each pinned by
tests against the real binaries, not by this document.
