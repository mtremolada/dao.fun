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

## 4b. Guarded mode — attacks on the front door (D-042/D-043)

Guarded realms move proposal AUTHORSHIP behind the gate program while
leaving voting untouched. That closes the sections above's open-realm
authorship paths and opens a smaller, sharper set of its own.

| # | Attack | Outcome |
|---|---|---|
| 4b.1 | **Author directly, bypassing the gate.** Buy supply, or borrow it, and call `create_proposal` on the realm. | **Refused for everyone.** `min_community_weight_to_create_proposal = u64::MAX` is an EXPLICIT disabled sentinel on this fork, not a large threshold — a full-supply whale AND their delegate are both rejected ("Voter weight threshold disabled", 0x25d). Proven on the deployed binary, `guarded-gate-spike` + `guarded-gate-v2`. |
| 4b.2 | **Smuggle an off-menu instruction through the gate.** Propose a whitelisted outer program wrapping a call to something else. | **Refused.** The gate parses the real `ProposalTransactionV2`, unwraps the Squads message, and whitelists OUTER AND INNER program ids (D-030). Asserted by an off-menu insert being rejected mid-chain. |
| 4b.3 | **Author with a zero-weight council record.** | **Refused** — the fork gates on WEIGHT, not identity, so an empty record cannot author either. |
| 4b.4 | **Steal the gate's authorship.** The gate's sole council token (supply 1, mint authority null) is the only thing that can author. | Held by a PDA's token-owner record, deposited by the program itself via CPI. No key exists that can move it. |
| 4b.5 | **Widen the whitelist by proposal.** Pass a proposal that adds programs to the menu. | Structurally one-way: INV-11 is a RATCHET — the gate accepts narrowing, never widening. |
| 4b.6 | **Grief by proposal spam.** Anyone may author through the gate; each proposal costs a deposit. | Accepted. The deposit is the rate limit, and the alternative (permissioned authorship) is the thing guarded mode exists to avoid. Voters ignore junk; nothing executes without a passing vote. |

**Residual, stated plainly.** The gate program's upgrade authority is a
capture path: an upgraded gate could widen its own whitelist or author
anything. This is the same class of risk as the launchpad's own upgrade
authority and is NOT mitigated by anything above — it is retired by revoking
the authority (or moving it to governance) before mainnet, and until that
happens "guarded" means "guarded by a program someone can still change".

One operational note that is not an attack but bites callers: a gate-created
proposal is OWNED by the gate's council token-owner record, not the
proposer's. Finalize and execute must pass that record or governance refuses
with "Invalid Proposal Owner" — pinned in `guarded-gate-v2`.

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

## 6. Launchpad public-surface threats (devnet dapp)

New attack surface from hosting the launchpad publicly. Each is dispositioned;
the on-chain program invariants (no withdraw path, INV-VAULT-PDA-ONLY,
INV-MINT-MATCH, INV-CPI-PINNED, INV-LP-BURNED, INV-FEE-SNAPSHOT) are proven by
tests/launchpad-*.integration.test.ts against the real binaries and are not
restated here.

- **6.1 RPC-proxy abuse.** `POST /rpc/devnet` could be used as someone's free
  Helius quota. Mitigation: method allowlist (no getProgramAccounts/airdrop),
  per-IP token bucket, and a SEPARATE Helius key from the indexer's — worst
  case the proxy key is exhausted and the browser falls back to public devnet
  RPC; the indexer is unaffected. (packages/backend/test/launchpad.test.ts.)
- **6.2 Airdrop draining.** The faucet endpoint could be drained. Mitigation:
  server-side only, per-IP + per-pubkey cooldown + global daily cap; on 429 the
  UI deep-links to faucet.solana.com. Worst case: our airdrop quota burns, UX
  degrades to the public faucet.
- **6.3 Metadata-upload abuse.** 8 MiB route cap, MIME allowlist (no SVG —
  script-injection vector), sharp re-encode kills polyglot files, ≤100 KiB
  output keeps Turbo/self-host free, per-IP limits, volume quota on the fallback
  dir. Assets served read-only with ACAO:* (explorer requirement).
- **6.4 Clickjacking.** The #1 wallet-dapp attack (invisible iframe over the
  confirm button). `frame-ancestors 'none'` + `X-Frame-Options: DENY` enforced
  from day one in next.config.mjs, before any soak.
- **6.5 Wrong-cluster broadcast.** A wallet on mainnet signing a devnet tx.
  Mitigated by the send pipeline (D-038): sign-only + broadcast to OUR devnet
  RPC by default, chains preflight, and landing verification — a tx can never
  silently land on mainnet, and the user gets explicit "enable Testnet Mode"
  guidance. Residual: the user must set their wallet to devnet; the UI tells
  them how per wallet.
- **6.6 CORS / SSE exhaustion.** Exact-origin CORS (no credentials); `/meta/*`
  is deliberately `*` and read-only. SSE has a per-IP connection cap + heartbeat
  GC.
- **6.7 Spam coin creation.** On-chain and permissionless by design — accepted;
  board ranking / "new" decay is the mitigation surface, not a gate.
- **6.8 Closed-source CPMM / lock-program upgrade risk.** Raydium's CPMM is
  upgradeable (~quarterly). Residual: monitored via the deploy-slot watch in
  RUNBOOK; migration reads `create_pool_fee` live, and the graduation suite is
  re-run against a fresh dump on any slot change. We do NOT depend on the
  closed-source LP-lock program (LP is burned, not locked — operator decision).

## Verdict

No capture path found on simulated micro-tier in either MVP mode that
defeats (a) the zero-weight-unlocked entry gate, (b) the lockup-vs-drain
dichotomy, and (c) the hold-up + veto/exit-window layer — each pinned by
tests against the real binaries, not by this document.
