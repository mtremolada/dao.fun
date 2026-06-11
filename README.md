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
