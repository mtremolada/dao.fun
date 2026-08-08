# Repo map: frontend + backend for launchpad pages & indexing

## 1. Frontend — `app/` (`@daofun/app`)

**Framework**: Next.js **^15.5.19**, **App Router**, React 19.2, TypeScript, `"type": "commonjs"`. Dev/start on port **3210**. `next.config.mjs` supports a **fully static export** (`STATIC_EXPORT=1` → `output: "export"`, `trailingSlash`, `NEXT_PUBLIC_BASE_PATH` for GitHub Pages). `transpilePackages: ["@daofun/sdk"]` (sdk subpath exports resolve to raw `.ts` source). **The app is deliberately serverless**: all chain reads go over the visitor's RPC, all txs are built in-browser and signed+sent by the wallet. Deployed to GitHub Pages by `.github/workflows/deploy-pages.yml`.

**Complete page inventory** (all 4 routes; no API routes, no dynamic segments — dynamic data lives in query strings so deep links work on static hosting):
- `/` — mode-selection cards (`app/app/page.tsx`, server component, static data)
- `/launch?mode=council|cypherpunk|sovereign` — `app/app/launch/page.tsx` → `components/launch-screen.tsx` → `components/launch-form.tsx` (a full launch form already exists: name/symbol/image/dev-buy/tier/governance params, multi-step progress UI, runs the real mainnet ceremony)
- `/dao?realm=&vault=&wallet=` — `app/app/dao/page.tsx` → `components/dao-screen.tsx` (vault balance, sweep-history table, vote power)
- `/proposal?id=&votingCompletedAt=&holdUpSeconds=` — `app/app/proposal/page.tsx` → `components/proposal-screen.tsx` (state, veto badge, hold-up countdown/execute gate, vote panel; the two override params bypass RPC for tests/demos)

**Styling**: no component library, no Tailwind — one hand-rolled dark-theme stylesheet `app/app/globals.css` with CSS variables (`--bg #0d1117, --panel, --border, --text, --muted, --green, --red, --amber`). Reusable classes: `.card` + `.mode-grid` (card grid), `.button`, `.badge[data-state="verified"|"mismatch"|"missing"]` (status pills), `.errors`, `.muted`, `pre.result`, `form.launch` input styling, plain `<table>` (sweep history), and a full wallet modal/dropdown kit (`.wallet-*`). No toast system — the pattern is inline status lines with `data-phase`/`data-testid` (see `wallet-actions.tsx` vote status and `launch-form.tsx` step list with ⏳/✅/❌).

**Wallet connection flow (D-028 — IMPORTANT: the doc phrase "server-built txs" is now stale for the app)**. The current flow is 100% client-side:
1. `lib/wallet-standard.ts` — hand-rolled wallet-standard client (~170 lines, no `@solana/wallet-adapter`): `subscribeWallets()` mounts the `wallet-standard:register-wallet` listener and dispatches `wallet-standard:app-ready`; `connectWallet()` calls the `standard:connect` feature.
2. `lib/wallet-registry.ts` — allowlist (**Phantom only**, `ALLOWED_WALLET_NAMES`), last-wallet persistence in localStorage `daofun:last-wallet`, eager silent reconnect, `truncateAddress`, `slugify`, install links.
3. `lib/injected.ts` — preferred connect path via `window.phantom.solana` injected provider (avoids Phantom's wallet-standard -32603 bug); also has Solflare support (filtered out by the allowlist today).
4. `lib/wallet-sender.ts` — the signing seam: `WalletSender.signAndSend(tx, connection)` prefers the `solana:signAndSendTransaction` feature (wallet signs AND broadcasts via its own RPC; tx serialized with `requireAllSignatures:false`), falls back to `solana:signTransaction` + `connection.sendRawTransaction`.
5. `lib/ledger.ts` — lazy-loaded WebHID Ledger (`@ledgerhq/hw-app-solana`, path `44'/501'/0'`), device signs, read-Connection broadcasts.
6. `components/wallet-provider.tsx` — app-wide React context (`useWallet()`): wallets list, account, `sender`, connect/disconnect, modal state, silent reconnect on load, external account-change handling. Mounted in `app/app/layout.tsx` with `components/wallet-button.tsx` (header pill+dropdown) and `components/wallet-modal.tsx`.
7. Tx building is in-browser: `lib/vote.ts` (cast-vote/deposit ixs via `@solana/spl-governance`, chain context read client-side), `lib/governance-actions.ts` (build→sign→send flow state machine with injectable builder/sender for offline tests), `lib/launch.ts` (`runLaunch`: 5–7 sequential wallet-signed txs — Squads treasury, optional launch fee, pump `create_v2` with vault-PDA creator, realm+governance, prefund — using `@daofun/sdk` builders), `lib/pump-metadata.ts` (client-side square-crop + upload to `https://pump.fun/api/ipfs`).

The backend's D-028 "unsigned tx over HTTP" seam (`packages/backend/src/tx-builder.ts`, `POST /chain/txs/*`) still exists and is fully tested, but **the app no longer calls any backend endpoint** — `lib/chain.ts` duplicates the backend `chain-reader` logic client-side (`getProposalState`, `getDashboard`).

**State management**: React context + `useState`/`useEffect` only. No zustand/redux/react-query/SWR.

**Backend communication**: none today (REST handler exists but unwired). RPC via `lib/solana.ts`: `NEXT_PUBLIC_RPC_URL` build default → public mainnet fallback, user-overridable with `?rpc=` (persisted in localStorage `daofun:rpc`).

## 2. Backend — `packages/backend/` (`@daofun/backend`)

**Framework**: none — a bare `node:http` `RequestListener` built by `createApiHandler(deps)` in `src/http-api.ts` with dependency injection (`ApiDeps`), so the same handler runs in tests/dev/prod. 256 KiB body cap. There is **no production entrypoint in the package**; the only server bootstrap is `scripts/serve-frontend-mainnet.ts` (read-only demo on :4404).

**Every endpoint** (in `src/http-api.ts`):
- `GET /health`
- `POST /launches` `{launchId, form}` — re-validates with the shared `validateLaunchForm`, runs the resumable step machine (`src/launch-machine.ts`: idempotent named steps, state persisted after every step; 201 complete / 502 failed-resumable)
- `GET /launches/:id`
- `POST /snapshots` `{mint, totalLamports, excludeOwners[]}` — holder snapshot + `proRataShares` (sdk) → share list
- `GET /artifacts/:proposal/:ixSetHash` — simulation/decode artifacts (spec 12.3)
- `POST /chain/txs/deposit | cast-vote | submit` — D-028 unsigned-tx builders + raw submit (501 until `txs` dep configured)
- `GET /chain/proposals/:pubkey` — chain-derived proposal state + `detectProposalAnomalies` flags (hash-mismatch/zero-hold-up etc.)
- `GET /chain/dao/:realm?vault=&wallet=` — dashboard (vault balance, sweep history, vote power)

**Database**: **sqlite via Node 22's built-in `node:sqlite`** (`DatabaseSync`, zero native deps) — but only for artifacts: `src/sqlite-store.ts` `SqliteArtifactStore` (table `artifacts(proposal, ix_set_hash, artifact JSON, updated_at)`), env form `ARTIFACT_STORE=sqlite:<path>` via `fromEnv`. Launch state is `MemoryLaunchStore` only. **No Postgres, no ORM, no coin/trade tables — launchpad indexing storage must be added; `node:sqlite` is the established pattern.**

**Holder-snapshot service (D-026)** — `src/holder-snapshot.ts`:
- `RpcHolderSnapshot`: `getProgramAccounts` on Token-2022, memcmp mint@offset 0, 72-byte dataSlice, `withContext` pins the slot; auto-falls back to `getTokenLargestAccounts` (exact ≤19 holders, **throws at the top-20 cap** rather than truncate).
- `DasHolderSnapshot`: Helius DAS `getTokenAccounts` with cursor pagination, bigint-safe amounts.
- `makeHolderSnapshotSource({connection, heliusUrl?})` picks DAS when Helius is configured.

**RPC configuration**: classes take an injected `Connection`; env reading lives in scripts. Conventions (`.env.example`, SPEC.md §3 — "all defaults work with zero third-party signups"): `CLUSTER`, `RPC_URL` (scripts), `SOLANA_RPC_URL` (scripts, default `https://api.mainnet-beta.solana.com`), `HELIUS_API_KEY` (optional, graceful degrade), `PROTOCOL_LAUNCH_FEE_LAMPORTS`, `PROTOCOL_SHARE_BPS`, `ARTIFACT_STORE=sqlite:<path>`. Frontend build-time vars: `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_BASE_PATH`, `STATIC_EXPORT`, `NEXT_PUBLIC_PROTOCOL_TREASURY`, `NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS`.

**Websocket/streaming**: **none anywhere** (grep confirms no WebSocket/onLogs/onAccountChange/SSE). **On-chain event indexing**: none — the only history read is `RpcChainReader.getDashboard` doing `getSignaturesForAddress(vault, limit 10)` + per-sig `getTransaction` to compute vault balance deltas, on demand per request. A live trades/chart feature needs new infra (polling or Helius websockets) built from scratch.

Sibling packages: `packages/sdk` (all instruction builders, PDAs, `PumpFunRail` wrapping `@pump-fun/pump-sdk` — buy-amount math `getBuyTokenAmountFromSolAmount` is already imported there; subpath exports keep chain deps out of the app bundle) and `packages/keeper` (fee-collection decision core, pure + service wiring, no daemon).

## 3. e2e — `app/e2e/` (Playwright)

`app/playwright.config.ts`: testDir `./e2e`, `webServer: npx next dev -p 3210`, baseURL `http://127.0.0.1:3210`, `reuseExistingServer: !CI` (← the "stale server" gotcha in CLAUDE.md), fullyParallel, 60s timeout. **Current pattern is serverless — there is no stub API server anymore** (the "Playwright stub server" in CLAUDE.md/D-017/D-028 is historical; its living relatives are `scripts/serve-frontend-mainnet.ts` and the backend tests that `createServer(createApiHandler(fakes))`).

How the chain is mocked today:
- **No RPC is ever touched**: screens accept query-param overrides (`?votingCompletedAt=&holdUpSeconds=` on /proposal) and the other specs only assert no-network guard paths (missing-param errors) and pure client validation (launch floors).
- **Wallet mocking** (`e2e/wallet.spec.ts`): `page.addInitScript` registers a fake wallet named "Phantom" through the **real** `wallet-standard:app-ready`/`register-wallet` handshake AND injects a fake `window.phantom.solana` provider (the app prefers injected). Fake `signAndSendTransaction` returns a canned signature.

Specs: `wallet.spec.ts` (connect modal, persistence, disconnect, no-wallet install links), `launch.spec.ts` (mode cards, sovereign double-confirm, sub-floor override rejection), `proposal.spec.ts` (hold-up countdown/execute gate), `dashboard.spec.ts` (param guard).

## 4. Unit test patterns

All vitest, per-package `vitest.config.ts` (`test/**/*.test.ts`, 30s). Root `vitest.config.ts` covers `tests/**` (bankrun integration vs real mainnet binaries gunzipped from `tests/fixtures/*.so.gz`) and pins `@pump-fun/pump-sdk` to its CJS entry (broken ESM, D-002).
- **App** (`app/test/`): pure-logic tests with injected seams — `governance-actions.test.ts` (flow machine with fake sender + `buildTx` override, asserts phase order and that the built tx is what gets sent), `launch-form.test.ts`, `wallet-registry.test.ts`. No React component tests, no jsdom.
- **Backend** (`packages/backend/test/`): spin a real `node:http` server around `createApiHandler` with `MemoryLaunchStore`/`MemoryArtifactStore` + fake `ChainReader`/snapshot/tx sources, then `fetch()` the routes ("written before implementation", route-contract pinning) — `http-api.test.ts`, `chain-api.test.ts` are the templates to copy for new endpoints. `sqlite-store.test.ts` covers the `ARTIFACT_STORE` env parsing.

## Direct answers for the planner
- A **launch form already exists** (`components/launch-form.tsx` + `lib/launch.ts`); a coin-launch page is an extension, not greenfield.
- **Coin list/detail**: reuse `.card`/`.mode-grid` (list), the dao-screen table, `.badge` pills, `WalletActions`-style tx buttons + inline `data-phase` status (no toast lib), `truncateAddress`, `getConnection()`; follow the query-string-params + `Suspense`-wrapped client-screen page pattern.
- **Backend indexing**: extend `ApiDeps` + `createApiHandler` with new injected sources, store in `node:sqlite` following `SqliteArtifactStore`, wire env in a script/entrypoint (none exists yet), and expect to introduce the repo's first streaming/polling infra for live trades.

## KEY FILES
- /home/user/dao.fun/app/next.config.mjs — Next.js 15 config: static-export (GitHub Pages) switch, transpilePackages for @daofun/sdk, explicit 'no backend' doctrine comment
- /home/user/dao.fun/app/app/layout.tsx — Root layout: WalletProvider context + header WalletButton on every page
- /home/user/dao.fun/app/app/page.tsx — Route / — mode-selection card grid (.card/.mode-grid, the pattern for a coin list)
- /home/user/dao.fun/app/app/launch/page.tsx — Route /launch?mode= (Suspense + client screen pattern)
- /home/user/dao.fun/app/app/dao/page.tsx — Route /dao?realm=&vault=&wallet=
- /home/user/dao.fun/app/app/proposal/page.tsx — Route /proposal?id=
- /home/user/dao.fun/app/components/launch-form.tsx — Existing launch form: metadata+image upload, tier/governance inputs, multi-step progress UI, NEXT_PUBLIC_PROTOCOL_TREASURY/LAUNCH_FEE env
- /home/user/dao.fun/app/lib/launch.ts — Client-side launch orchestrator: 5-7 wallet-signed txs (Squads treasury, pump create_v2, realm/governance) with per-step callback
- /home/user/dao.fun/app/lib/wallet-sender.ts — The signing seam: WalletSender.signAndSend — signAndSendTransaction feature preferred, signTransaction+sendRawTransaction fallback
- /home/user/dao.fun/app/lib/wallet-standard.ts — Hand-rolled wallet-standard protocol client (discovery handshake, connect/disconnect/events) — D-028 client side
- /home/user/dao.fun/app/components/wallet-provider.tsx — App-wide wallet React context (useWallet): connect modal, eager silent reconnect, sender exposure
- /home/user/dao.fun/app/lib/injected.ts — Preferred Phantom/Solflare injected-provider connect path (works around wallet-standard -32603)
- /home/user/dao.fun/app/lib/solana.ts — Client RPC: NEXT_PUBLIC_RPC_URL default, ?rpc= override persisted in localStorage daofun:rpc
- /home/user/dao.fun/app/lib/chain.ts — Client-side chain reads (proposal state, DAO dashboard) — browser duplicate of backend chain-reader
- /home/user/dao.fun/app/lib/vote.ts — In-browser cast-vote/deposit tx builders (spl-governance, fork program GovER5…)
- /home/user/dao.fun/app/lib/governance-actions.ts — build→sign→send flow state machine (FlowState phases) with injectable seams — template for any new tx button
- /home/user/dao.fun/app/lib/pump-metadata.ts — Client-side image crop + upload to pump.fun/api/ipfs → metadata URI
- /home/user/dao.fun/app/app/globals.css — The entire styling system: dark CSS variables, .card/.button/.badge/.errors/table/wallet-modal classes
- /home/user/dao.fun/app/components/wallet-actions.tsx — Vote panel: connected-gated tx buttons + inline data-phase status line (the toast substitute)
- /home/user/dao.fun/app/playwright.config.ts — Playwright: next dev :3210 webServer, serverless, reuseExistingServer gotcha
- /home/user/dao.fun/app/e2e/wallet.spec.ts — The wallet-mocking pattern: fake wallet-standard registration handshake + fake window.phantom.solana via addInitScript
- /home/user/dao.fun/packages/backend/src/http-api.ts — The whole API: bare node:http createApiHandler(ApiDeps) with every route (/launches, /snapshots, /artifacts, /chain/*, /chain/txs/*)
- /home/user/dao.fun/packages/backend/src/holder-snapshot.ts — D-026 holder snapshots: RpcHolderSnapshot (gPA+dataSlice, top-20 fallback that refuses truncation) + Helius DasHolderSnapshot
- /home/user/dao.fun/packages/backend/src/sqlite-store.ts — node:sqlite storage pattern (SqliteArtifactStore, ARTIFACT_STORE=sqlite:<path>) — the template for new indexing tables
- /home/user/dao.fun/packages/backend/src/chain-reader.ts — ChainReader seam: RpcChainReader (proposal hash recompute INV-9, vault sweep history via getSignaturesForAddress) + detectProposalAnomalies
- /home/user/dao.fun/packages/backend/src/tx-builder.ts — D-028 server-built unsigned-tx seam (deposit/cast-vote/submit) — tested but currently unused by the app
- /home/user/dao.fun/packages/backend/src/launch-machine.ts — Resumable idempotent step machine + LaunchStore interface (MemoryLaunchStore only)
- /home/user/dao.fun/packages/backend/test/http-api.test.ts — Backend test pattern: real http server + Memory stores + fetch, route contract pinned before implementation
- /home/user/dao.fun/packages/backend/test/chain-api.test.ts — Fake-ChainReader injection pattern for /chain/* route tests
- /home/user/dao.fun/scripts/serve-frontend-mainnet.ts — The only backend server bootstrap (read-only demo :4404, SOLANA_RPC_URL) — model for a real entrypoint
- /home/user/dao.fun/packages/sdk/package.json — sdk subpath exports (./launch-form, ./pda, ./treasury, ./governance, ./rails/pumpfun point at src/*.ts; barrel '.' points at dist)
- /home/user/dao.fun/packages/sdk/src/rails/pumpfun.ts — PumpFunRail over @pump-fun/pump-sdk (create_v2, fee collection, buy-amount curve math) — the chain layer a coin-detail chart would price against
- /home/user/dao.fun/.env.example — Backend env contract: CLUSTER, RPC_URL, HELIUS_API_KEY, PROTOCOL_LAUNCH_FEE_LAMPORTS, PROTOCOL_SHARE_BPS, ARTIFACT_STORE
- /home/user/dao.fun/.github/workflows/deploy-pages.yml — Static-export deploy: builds sdk first, STATIC_EXPORT=1, NEXT_PUBLIC_RPC_URL from repo variable
- /home/user/dao.fun/app/test/governance-actions.test.ts — App unit-test pattern: injected fake sender/builder, no jsdom, phase-order assertions

## REUSABLE
- Card grid for a coin list @ app/app/page.tsx + .card/.mode-grid/.card.disabled in app/app/globals.css — Mode cards are structurally identical to coin cards (title, tagline, bullet stats, CTA link with ?query params); data-testid convention `mode-card-<id>`
- Data table @ app/components/dao-screen.tsx sweep-history <table> — Plain table, ISO timestamps, signed SOL delta formatter `sol()`; word-break for signatures
- Status badges @ .badge[data-state=verified|mismatch|missing] in globals.css; used in proposal-screen.tsx and launch-form.tsx — Green/red/amber pills — ready for 'live/graduated/failed' coin states
- Tx button + inline status (toast substitute) @ app/components/wallet-actions.tsx + app/lib/governance-actions.ts FlowState — Connected-gated buttons, busy-disable, phases building→sending→done/error rendered as a data-phase paragraph; copy this for buy/sell/trade buttons
- Multi-step progress list @ app/components/launch-form.tsx `steps` state + lib/launch.ts onStep callback — ⏳/✅/❌ per named step with signature/error — reuse for any multi-tx ceremony
- Wallet context + modal + header pill @ app/components/wallet-provider.tsx, wallet-modal.tsx, wallet-button.tsx — useWallet() gives {sender, account, openModal}; every new page gets wallet connect for free via the root layout
- WalletSender signing seam @ app/lib/wallet-sender.ts (+ injected.ts, ledger.ts variants) — Any new tx flow should accept a WalletSender and a Connection — that's what makes it e2e/unit mockable
- RPC connection helper @ app/lib/solana.ts getConnection()/getRpcUrl() — Honors NEXT_PUBLIC_RPC_URL and the ?rpc= user override
- Address helpers @ app/lib/wallet-registry.ts truncateAddress()/slugify() — Truncated pill format GRdk…t8wR; slug for data-testids
- API handler + DI pattern for new endpoints @ packages/backend/src/http-api.ts createApiHandler(ApiDeps) — Add new injected sources (e.g. CoinIndex) to ApiDeps; 501 when unconfigured; tests fetch a real server around the handler
- sqlite storage template @ packages/backend/src/sqlite-store.ts — node:sqlite DatabaseSync, CREATE TABLE IF NOT EXISTS in ctor, fromEnv('sqlite:<path>') convention — copy for coins/trades tables
- Holder snapshot sources @ packages/backend/src/holder-snapshot.ts makeHolderSnapshotSource — Helius-or-RPC selection pattern; the DAS JSON-RPC helper class is a ready template for other Helius endpoints
- Vault activity history read @ packages/backend/src/chain-reader.ts getDashboard (getSignaturesForAddress + getTransaction + pre/post balance delta) — The closest existing thing to trade indexing — extend/replace for a trades feed
- Pump curve math + create/buy instruction builders @ packages/sdk/src/rails/pumpfun.ts (imports getBuyTokenAmountFromSolAmount from @pump-fun/pump-sdk) — Price/market-cap math for a live chart can come from the same pinned pump-sdk 1.36.0
- Fake-wallet e2e harness @ app/e2e/wallet.spec.ts beforeEach addInitScript — Registers via the real wallet-standard handshake AND fakes window.phantom.solana; reuse verbatim for trade-button e2e
- Chain-read bypass for e2e @ proposal-screen.tsx query overrides (?votingCompletedAt=&holdUpSeconds=) — Established convention: new screens should accept query overrides so Playwright never needs an RPC

## GOTCHAS
- CLAUDE.md's 'browser signing via wallet-standard + server-built txs (D-028)' is stale for the app: the frontend evolved to fully client-side (app/README.md + next.config.mjs say 'no backend'); the backend tx-builder seam (POST /chain/txs/*) exists and is tested but nothing in app/ calls it. A planner must explicitly choose: extend the serverless pattern (status quo, works on GitHub Pages) or wire the app to the backend API (which currently has no production entrypoint or deployment).
- Static-export constraint: the Pages deploy uses `output: 'export'` — no server rendering, no dynamic route segments, no Next API routes; every existing page passes data via query strings and wraps client screens in <Suspense>. New coin-detail pages must follow this (e.g. /coin?mint=... not /coin/[mint]) unless the static deploy is dropped.
- Workspace dist/ staleness: @daofun/sdk barrel ('.') and @daofun/backend resolve through dist/ — run `pnpm --filter @daofun/sdk build` (and backend) before integration/e2e pick up source changes. BUT sdk subpath exports (./launch-form, ./pda, ./treasury, ./governance, ./rails/pumpfun) point at src/*.ts directly (hence transpilePackages) — so the app sees those live while dist-consumers lag. Playwright reuses a stale `next dev` server unless killed (reuseExistingServer: !CI).
- No websocket/streaming/indexing infra exists anywhere in the repo — 'live chart/trades' is greenfield. Also no persistent launch/coin registry: launches are recorded nowhere server-side (LaunchStore is memory-only; sqlite is used only for proposal artifacts), so a coin list has no existing data source.
- Public RPC from datacenter IPs: token-program getProgramAccounts is index-excluded (-32010) AND per-method rate-limited — holder snapshots and any indexing need Helius/keyed RPC (HELIUS_API_KEY / SOLANA_RPC_URL); RpcHolderSnapshot deliberately throws rather than serve a truncated top-20 holder set.
- The deployed governance program GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw is a FORK of spl-governance (D-031/D-032): never build governance instructions from public-master enum indices; PROGRAM_VERSION=3 is pinned in app/lib/chain.ts, app/lib/vote.ts, backend tx-builder.ts and chain-reader.ts.
- Wallet allowlist is Phantom-only (ALLOWED_WALLET_NAMES in app/lib/wallet-registry.ts) even though injected.ts supports Solflare and the modal offers Ledger — widening wallet support is a one-line allowlist change plus KNOWN_WALLETS.
- Two launch-fee env conventions coexist: frontend NEXT_PUBLIC_PROTOCOL_TREASURY + NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS (baked at build) vs backend PROTOCOL_LAUNCH_FEE_LAMPORTS (.env.example) — don't conflate them.
- Node >= 22 is required (node:sqlite built-in); everything is CommonJS ('type': 'commonjs'); pnpm workspace (pnpm@10.33.0). @pump-fun/pump-sdk must be loaded via its CJS entry (broken ESM — root vitest.config.ts alias, D-002).
- The 'Playwright stub server' mentioned in CLAUDE.md/DECISIONS no longer exists in the tree — current e2e is serverless (query overrides + fake wallet); the pattern survives only in backend tests and scripts/serve-frontend-mainnet.ts.
- pump.fun/api/ipfs upload can be CORS-blocked in some browsers — launch-form's fallback is a user-pasted metadata URI ('Advanced'); a server-side upload proxy would be a new backend endpoint.
- The frontend duplicates backend read logic (app/lib/chain.ts vs packages/backend/src/chain-reader.ts) minus the INV-9 hash recompute — adding backend indexing means deciding which side owns reads, or the duplication grows.
- Repo doctrine: tests BEFORE code on anything touching funds/PDAs/governance; push only to branch claude/spec-driven-repo-reset-yqzenh; commit messages end with the session URL footer; never commit private keys (programs/target/ is gitignored because cargo-build-sbf drops a keypair there).
