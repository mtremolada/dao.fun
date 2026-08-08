# PumpFun DAO Launchpad

Launch pump.fun tokens whose creator fees flow to an on-chain,
holder-governed treasury — no human key in the custody path from day one.

Spec-driven build: the canonical spec is `SPEC.md` (v2.0). Working agreements:

- **Spec before code** — contract, then failing test, then implementation.
- **Gates are hard stops** — evidence in `GATES.md`, operator sign-off required.
- `PROGRESS.md` — checklist state. `DECISIONS.md` — verification log and
  recorded deviations. `VERSIONS.md` — exact pins.

## Layout

```
packages/sdk      rails, PDAs, ix builders, ExecutionAdapter, types
packages/keeper   permissionless fee-sweep service
packages/backend  launch orchestration API + artifact store
app               Next.js frontend (Stage 1)
programs/         launch-coordinator, proposal-gate (Stage 3, Anchor)
scripts/          init-wallets, gate validations
tests/            cross-package tests
```

## Quickstart (devnet, zero signups)

```bash
pnpm install
pnpm test            # unit suites
pnpm init-wallets    # generate + faucet-fund devnet wallets (.wallets/, gitignored)
pnpm gate:0a         # GATE 0a validation run
```

## Launchpad (public devnet dapp)

Beyond the DAO product, this repo is a full pump.fun-style launchpad: launch a
coin on a fair bonding curve (whole supply on the curve, mint + freeze
authorities revoked, no presale) that **graduates to a real Raydium CPMM pool
with the LP burned**. Optionally launch "as a DAO" so the curve's creator-fee
stream flows to a holder-governed Squads/Realms treasury.

- **Program** `programs/launchpad-curve` — constant-product curve over virtual
  reserves, permissionless idempotent `migrate` (no withdraw path, ever). Proven
  on the real Raydium + Metaplex binaries in bankrun.
- **SDK** `@daofun/sdk/launchpad` — browser-safe builders, event codec, cluster
  selection. `@daofun/sdk/curve-math` is the pricing spec the program mirrors.
- **Backend** `packages/backend/src/server.ts` — one always-on service: polling
  indexer, board/coin/trade REST + SSE, metadata upload, RPC proxy, airdrop.
- **Frontend** `app/` — `/board`, `/coin?mint=`, `/create`, with a send pipeline
  that keeps devnet transactions on devnet (the wallet-broadcast trap, D-038).

**Run it locally (devnet):**
```
pnpm install && pnpm -r build
# backend (indexer + API) — see .env.example for the full var list
CLUSTER=devnet RPC_URL=https://api.devnet.solana.com \
  LAUNCHPAD_PROGRAM_ID=<id> LAUNCHPAD_STORE=sqlite:.data/launchpad.db \
  node packages/backend/dist/server.js
# frontend
cd app && NEXT_PUBLIC_CLUSTER=devnet NEXT_PUBLIC_API_URL=http://localhost:4500 \
  NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID=<id> pnpm dev
```

**Deploy it publicly** (program → devnet, backend → Railway, frontend → Vercel):
see **RUNBOOK.md** for the step-by-step with env tables and the operator
checklist. Tests: `pnpm test:unit` (308) + `pnpm test:integration` (real
binaries in bankrun).
