# CLAUDE.md — session memory for the PumpFun DAO Launchpad

Spec-driven build per **SPEC.md** (v2.0 — the only authoritative spec).
Doctrine: tests BEFORE code on anything touching funds/PDAs/governance;
verify against the deployed binary before trusting any interface; record
everything in **DECISIONS.md** (D-001..D-051 so far); gate evidence in
**GATES.md**; running checklist in **PROGRESS.md**; pins in
**VERSIONS.md**; capture analysis in **REDTEAM.md**.

## ✅ DEVNET LIVE (2026-08-09) — fee model deployed and walked end to end

Program upgraded on devnet (sig 3BACkmffgQid…), config pointed at the **1%
tier** (`EsTevfacYXpuho5VBuzBjDZi8dtWidGnXoSYAr8krTvz` — devnet index 3;
mainnet's 1% is index 1, which is why tiers are stored as ADDRESSES).
`lockProgram` stays `PublicKey.default` on devnet: Raydium's locker is not
deployed there, so migrate burns.

Proof coin: `42io3su15PAvmmjsNqVbPMKcaeMzjCNDzF4nf1GNCDB6`, pool
`ER5ujesyLafk21ZuQ425FtKN1sjJKkg2i9GVcLTYa2rd`. create → buy → sell →
buy-out → migrate → collect_protocol_fee → collect_creator_fee, all on
chain. The RAISE-FALLBACK path was exercised for real: devnet's 2.83 SOL
raise earns only 0.0198 SOL of protocol fee against 0.1922 of overhead, so
the vault paid 0.023987 and the raise covered 0.168169 — summing to the
overhead exactly. On mainnet the vault covers it 2.76×.

**Deploy gotchas (runbook):** `solana program deploy` needs `--use-rpc` from
this container — the CLI's TPU/pubsub path fails TLS through the agent proxy
with `InvalidCertificate(UnknownIssuer)`. Failed attempts orphan buffers
holding ~3.6 SOL each; `solana program show --buffers --buffer-authority
<deployer>` then `solana program close <buffer>` recovers them. Public devnet
faucets rate-limit this datacenter IP entirely — funding must come from a
browser faucet or the operator.

## ✅ SHIPPED: perpetual post-graduation fees (G0–G3, D-049/D-050)

Program, SDK, keeper crank and app surface are all in. What remains is
GATE L4 — one mainnet canary — which is operator-gated and cannot be
substituted: Raydium's locker is absent from devnet and hard-codes the
mainnet CPMM id, so bankrun against the real binaries is the primary proof
and devnet only ever exercises the burn branch.

## ⚠️ Test-suite gotcha you WILL hit: the bankrun wedge (D-051)

Roughly one full integration run in three used to die with a bare "Test
timed out in 300000ms". It is not your test: solana-bankrun occasionally
leaves a promise unsettled and the worker's event loop goes completely idle.
Every bankrun call now races a 60s watchdog, so it fails NAMING THE CALL
(`BANKRUN_CALL_TIMEOUT_MS=0` disables). Before blaming a change, run `ps` —
an orphaned vitest tree from an earlier session competing for the 4 cores
correlated with every wedge observed, and it will not show up in your own
logs.

## ▶ REFERENCE: post-graduation fee design — PLAN-GRADUATED-FEES.md

**G0 DONE (D-049, 8/8 green:
tests/launchpad-lock-verify.integration.test.ts).** Raydium's locker
`LockrWmn…` verified on the DEPLOYED binary in bankrun. Facts G1 builds on:
`recipient_token_*` are UNCONSTRAINED (so our program can hard-wire the
destination and the crank stays permissionless); the fee-key NFT is the
SOLE collect authority; a PDA can both hold the key and `invoke_signed` the
collect; `fee_nft_mint` also accepts a PDA, so `migrate` stays
single-signer and the fee key's address is derivable; the lock is
irreversible (no unlock/withdraw/close entrypoint exists). Cost:
23,328,400 lamports + 166,769 CU to lock, 103,408 CU to collect — the
curve's 192,156,720 migration reserve must GROW by the lock cost in G1.
`locked_lp_amount` legitimately DECREASES as fees are claimed (k-growth is
redeemed as LP); the guarantee is "deposited value never leaves the pool",
not "LP count constant".

CORRECTED an earlier claim: the locker DOES have
`collect_clmm_fees_and_rewards` — both venues can lock AND collect. CPMM
is chosen on merit (full-range by construction; a locked CLMM position
cannot be rebalanced when price leaves its range), not on capability.

The locker hard-codes the MAINNET cpmm/clmm ids and is absent from devnet,
so the lock path can NEVER run on devnet: bankrun-with-mainnet-binaries is
the primary proof, devnet covers the burn branch and everything around it,
mainnet canary (GATE L4) is the only live run.

## ✅ Guarded SHIPPED (2026-08-09, D-043) — unified launch page live

Gate v2 (four PDA-signed CPIs, client-parity, proven on the deployed
binary incl. the production buildCreateDaoIxs("guarded") ceremony), SDK
gate module + guarded ceremony/form/matrix with the full 6.8 menu as
DEFAULT_GATE_WHITELIST, ONE /launch page (Guarded default, zero-config).
Remaining from PLAN-UNIFIED-LAUNCH: app-side GATED PROPOSE routing for
the action menu on guarded DAOs (dashboard/proposal screens still build
direct proposals — they must route via the gate builders for guarded
realms), a devnet gate deploy if live evidence is wanted, and REDTEAM
guarded row. The DAO launch flow itself remains mainnet/pump-rail.

## ✅ RESOLVED (2026-08-08): Guarded mode enforcement — Option A committed (D-042)

The D-032 pending decision is CLOSED. The operator delegated it
("make the decisions and finish the job"); the recorded recommendation
was executed: the Option A spike ran against the deployed GovER5 v3.1.4
binary and PASSED on every leg
(tests/guarded-gate-spike.integration.test.ts):

- `min_community_weight_to_create_proposal = u64::MAX` is an EXPLICIT
  disabled sentinel on this fork ("Voter weight threshold disabled",
  0x25d) — a full-supply whale AND their delegate are refused;
- a zero-weight council record cannot author (weight, not identity);
- the gate's SOLE council token (supply 1, mint authority null) authors
  proposals whose electorate is the COMMUNITY mint, and the community
  votes them to Succeeded — creation gated, voting untouched.

**Committed design:** ceremony mints the one council token to the gate
PDA's record + writes the guarded config; the gate's create_proposal CPI
runs the D-030 validation engine first. Option B rejected (unneeded),
C not taken. Still to build (Stage 3 WIP): the gate program's
create_proposal CPI instruction, "guarded" mode in buildCreateDaoIxs,
SDK/frontend, clearance flow. MVP scope unchanged (Council + Cypherpunk
first). GATE 2 and GATE L2 sign-off lines are filled (same delegation).

## Where the build stands (end of session …sbqvy)

- Branch: `claude/spec-driven-repo-reset-yqzenh` (push ONLY here; no PRs
  unless asked). Suites: 234 unit + 54 integration (real mainnet
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
