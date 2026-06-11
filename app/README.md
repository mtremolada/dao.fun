# app — Next.js frontend (Stage 1, checklist 13.7)

Contract: spec 6.7. The UI renders results from the SHARED launch-form
contract (`@daofun/sdk/launch-form`) — the backend re-validates with the
same functions, so client floors are convenience and server floors are
the contract.

- `app/` — app-router pages: mode selection (`/`), launch form
  (`/launch?mode=`), proposal view (`/proposal/[id]`), DAO dashboard
  (`/dao/[realm]?vault=&wallet=`).
- `components/` — client components (form, proposal view).
- `e2e/` — Playwright suite + a stub server that mounts the REAL
  `createApiHandler` from `@daofun/backend` with in-memory stores,
  stubbed launch steps, and a fake `ChainReader`.
- `/api/*` is rewritten to the backend HTTP API (`API_URL` env,
  default `http://127.0.0.1:4404`) — same-origin, no CORS.
- The proposal view and dashboard are chain-fed via the backend's
  `/chain/*` routes (`RpcChainReader`): the hash badge compares the
  artifact against the hash recomputed from the ON-CHAIN unwrapped
  instruction set (INV-9), and the dashboard reads vault balance, sweep
  history, and deposited vote power. Query params override the chain
  values on the proposal view for manual inspection (see D-017).
- `scripts/serve-frontend-mainnet.ts` (repo root) runs the API read-only
  against the GATE 1 mainnet DAO for a live demo.

```sh
pnpm --filter @daofun/app test       # unit (vitest)
pnpm --filter @daofun/app test:e2e   # Playwright (starts stub API + next dev)
pnpm --filter @daofun/app dev        # dev server on :3210
```

Wallet adapter is deliberately deferred (D-017): the launch ceremony is
backend-orchestrated, so the MVP UI needs no browser signing; user-signed
vote/execute from the browser is Stage 2 scope.
