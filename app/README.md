# app — Next.js frontend (fully decentralized, server-less — D-033)

The front end is a **static export** (`output: "export"`): a directory of
HTML/JS/CSS with **no backend and no key in any custody path**. Every action
runs in the browser against an RPC the user chooses — launch, read, verify,
vote, deposit. Deploy it to IPFS or any static host. See `../DEPLOY.md`.

Contract: spec 6.7. The UI renders results from the SHARED launch-form
contract (`@daofun/sdk/launch-form`), the same functions the on-chain
builders enforce.

## Routes (all static, query-param driven)

- `/` — governance mode selection.
- `/launch?mode=council|cypherpunk|sovereign` — the **full launch ceremony
  in the browser**: connect a wallet, the page generates the ephemeral
  keypairs (mint / Squads createKey / council mint) locally and co-signs
  every step with the wallet (`lib/client-launch.ts`), reusing the
  real-binary-tested builders + the unit-tested step machine. No server.
- `/proposal?id=<pubkey>` — proposal view read straight from chain
  (`@daofun/sdk/chain-reader`). The INV-9 hash badge compares the hash
  recomputed in-browser from the ON-CHAIN unwrapped instruction set against
  the proposer's published hash; red flags come from
  `detectProposalAnomalies`. Vote via the wallet (`lib/governance-actions.ts`).
  Query params (`chainHash`, `artifactHash`, `votingCompletedAt`,
  `holdUpSeconds`) override chain values for manual inspection.
- `/dao?realm=<pubkey>&vault=<pubkey>&mint=<pubkey>&wallet=<pubkey>` —
  dashboard: vault balance, sweep history, deposited vote power; deposit
  community tokens for vote weight via the wallet (the `mint`'s owner
  program is auto-detected for Token-2022). `vault` and `mint` are not
  derivable from the realm, so they are passed explicitly (the DAO's share
  link carries them).

## RPC (bring your own)

There is no shared backend. The default RPC is `NEXT_PUBLIC_RPC_URL` (build
time); each user can override it in-app (persisted to localStorage) — the
static host never sees a request. See `../.env.example` for the
`NEXT_PUBLIC_*` build inputs.

## Build & test

```sh
pnpm --filter @daofun/sdk build      # required first (the app consumes dist)
pnpm --filter @daofun/app build      # -> static export in app/out
pnpm --filter @daofun/app test       # unit (vitest)
pnpm --filter @daofun/app test:e2e   # Playwright (see e2e/ — write flows need a chain/RPC)
```

The keyed `packages/backend` (and `scripts/serve-frontend-mainnet.ts`) are
retained for the read-only demo and tests; the app has **no** dependency on
it and it is **not** part of the decentralized deployment.
