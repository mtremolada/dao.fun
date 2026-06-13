# CLAUDE.md — session memory for the PumpFun DAO Launchpad

Spec-driven build per **SPEC.md** (v2.0 — the only authoritative spec).
Doctrine: tests BEFORE code on anything touching funds/PDAs/governance;
verify against the deployed binary before trusting any interface; record
everything in **DECISIONS.md** (D-001..D-033 so far); gate evidence in
**GATES.md**; running checklist in **PROGRESS.md**; pins in
**VERSIONS.md**; capture analysis in **REDTEAM.md**.

## Shipped this session (…pvw5vy, 2026-06-13) — fully decentralized front end (D-033)

Operator directive: ship the most resilient, permissionless, **server-less**
deployment ("no devnet — shipping to production"). DONE and gate-green:
- **Branch `claude/pensive-feynman-pvw5vy`** (push ONLY here; no PRs unless
  asked).
- SDK is now **isomorphic**: a vendored, byte-exact SHA-256
  (`packages/sdk/src/sha256.ts`) replaces `node:crypto` (proven vs node AND
  the real binaries). `chain-reader`, `tx-builder`, `launch-machine`,
  `launch-steps` relocated to the SDK; backend keeps re-export shims.
- App is **`output: "export"` static** (no backend): read / verify (INV-9
  recomputed in-browser) / vote / deposit / **launch** all run client-side
  over a user-chosen RPC. Routes are query-param pages (`/proposal?id=`,
  `/dao?realm=&vault=&mint=`). The launch ceremony generates ephemeral
  keypairs locally and co-signs with the wallet
  (`app/lib/client-launch.ts`), reusing the real-binary-tested builders +
  step machine. **SUPERSEDES D-028.**
- Gate: 249 unit + 21 integration (real binaries) + root tsc/eslint clean +
  `next build` static export of all four routes. Deploy artifact is the
  IPFS-ready `app/out` (see **DEPLOY.md**).
- Residual (operator-accepted): live wallet/RPC flows (vote/deposit/launch)
  not exercisable in-container; builders + orchestrator + static bundle ARE
  verified. See DECISIONS.md D-033.

## ⚠️ PENDING OPERATOR DECISION — Guarded mode (separate track, unaffected)

**Topic: how Guarded mode (Stage 3, spec 6.9) gets its structural
enforcement.** Full background in DECISIONS.md **D-032**; explained to
the operator at the end of session `…sbqvy` (2026-06-12).

The finding that forces the decision: the **deployed mainnet governance
binary (`GovER5…`, v3.1.4) is a fork with NO required-signatory
mechanism** — verified directly against the binary (no
`process_add_required_signatory`, zero `RequiredSignatory` strings; it
has a versioned-transaction suite the public master lacks, so the public
solana-program-library source has DIVERGED from the deployment — do NOT
build governance instructions from public-master enum indices, see
D-031/D-032). The planned "gate PDA as required signatory blocks
uncleared proposals from voting" path is therefore impossible.

The three options, as explained to the operator:

- **Option A — gate the front door (recommended starting point).** The
  proposal-gate program holds the realm authority and gates
  proposal-CREATION: only the gate's own record can author proposals,
  and its create-proposal CPI runs the already-shipped D-030 validation
  engine first (off-menu proposals never come to exist). Cheapest path,
  reuses everything built. UNVERIFIED RISK: whether proposal-creation
  can be made truly exclusive to the gate on THIS fork (no
  whale/delegate loophole). Verifiable with a one-afternoon tests-first
  spike.
- **Option B — full custom/forked governance program.** Total control,
  unambiguous guarantee; far more code, full external audit, abandons
  the battle-tested deployed program. Only if A's spike fails.
- **Option C — don't ship Guarded.** Council/Cypherpunk/Sovereign only
  (the MVP scope anyway). Zero new risk; loses the headline
  "treasury can't drain even on a winning vote" product.

**Recommendation given: run the cheap verification spike for A before
committing to anything.** The operator will answer one of: "verify A" /
"commit B" / "defer Guarded (C)". Nothing about this blocks the MVP —
Council + Cypherpunk are complete and signed off.

Also pending from the operator: the **GATE 2 sign-off line** in GATES.md
(all technical legs determined 2026-06-12).

## Where the build stands (end of session …sbqvy)

- Branch: `claude/spec-driven-repo-reset-yqzenh` (push ONLY here; no PRs
  unless asked). Suites: 234 unit + 21 integration (real mainnet
  binaries in bankrun, hermetic) + 12 Playwright e2e; eslint+tsc clean.
- Stage 0 + Stage 1: DONE and operator-signed (GATES.md). GATE 2
  technical legs determined (property/fuzz/CU suites, observability,
  REDTEAM.md, audit dispositions).
- Action menu 6.8 COMPLETE (grant, burn, buyback curve+AMM,
  provideLiquidity, distribute on the immutable Jito merkle distributor,
  setParam). Holder-snapshot service (D-026), browser signing via
  wallet-standard + server-built txs (D-028).
- Stage 3 started: build pipeline proven (D-029 — cargo-build-sbf
  4.0.0 / platform-tools v1.53 / anchor-lang 0.30.1; platform-tools must
  be curl-fetched into ~/.cache/solana/v1.53/ because the proxy CA
  breaks the built-in downloader). proposal-gate v1 SHIPPED (D-030):
  on-chain validation engine (parses real ProposalTransactionV2,
  unwraps the Squads message, whitelist-enforces outer+inner programs)
  + structural one-way INV-11 ratchet. Both proven on real binaries.

## Operational gotchas that bit this session

- Workspace packages resolve through `dist/` — run
  `pnpm --filter @daofun/sdk build` (and backend) before integration/e2e
  pick up source changes; the e2e stub server reuses stale servers
  unless killed.
- `programs/target/` is gitignored: cargo-build-sbf drops a PRIVATE
  program-id keypair there. Our program fixtures are committed gzipped
  (`tests/fixtures/*.so.gz`) so CI needs no Rust toolchain; rebuild
  command in each test header.
- Public RPC from this datacenter IP: token-program gPA is
  index-excluded (-32010) AND per-method rate-limited (10/10 retries
  failed) — use Helius/keyed RPC for live holder snapshots (D-026).
- bankrun dedups byte-identical txs — disambiguate with a varying
  CU-limit instruction.
- Standing constraints: never commit/log private keys; mainnet keys are
  disposable gas-only (D-008); keep 0.01725 SOL in deployer
  `FMA5xzVDiEYptXfxNeS6PQtWRvrMyEy9FPLCFKMXcTds` (operator: frontend
  testing); commit messages end with the session URL footer.
