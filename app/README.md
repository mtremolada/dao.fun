# app — Next.js frontend (Stage 1, checklist 13.7)

Contract: spec 6.7. The UI renders results from the SHARED launch-form
contract (`@daofun/sdk/launch-form`) — the backend re-validates with the
same functions, so client floors are convenience and server floors are
the contract.

- `app/` — app-router pages: mode selection (`/`), launch form
  (`/launch?mode=`), proposal view (`/proposal/[id]`).
- `components/` — client components (form, proposal view).
- `e2e/` — Playwright suite + a stub server that mounts the REAL
  `createApiHandler` from `@daofun/backend` with in-memory stores and
  stubbed launch steps.
- `/api/*` is rewritten to the backend HTTP API (`API_URL` env,
  default `http://127.0.0.1:4404`) — same-origin, no CORS.

```sh
pnpm --filter @daofun/app test       # unit (vitest)
pnpm --filter @daofun/app test:e2e   # Playwright (starts stub API + next dev)
pnpm --filter @daofun/app dev        # dev server on :3210
```

Not yet wired (Stage 1 remainder): wallet adapter, the chain reader that
feeds the proposal view (hash/timestamps arrive as query params today),
dashboard (vault balance, sweep history, lockup-weighted vote power).
