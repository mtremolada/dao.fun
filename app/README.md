# app — Next.js frontend (static, serverless, GitHub Pages)

A fully client-side dapp: **no backend**. It reads chain state over the
visitor's RPC and sends transactions through their **connected wallet's own
RPC** — exactly how a normal dapp works. Deploys as a static export to
GitHub Pages.

- `app/` — app-router pages, all statically exported and client-rendered:
  mode selection (`/`), launch form (`/launch?mode=`), proposal view
  (`/proposal?id=`), DAO dashboard (`/dao?realm=&vault=&wallet=`). Dynamic
  data lives in the query string so deep links work on static hosting.
- Universal wallet connect: a persistent top-right control opens a modal
  with every detected wallet-standard wallet plus install links for popular
  ones. The choice is persisted and silently reconnected on load (stays
  logged in). Built on the raw wallet-standard protocol (`lib/wallet-*`).
- `lib/solana.ts` — client RPC for reads: public default, overridable with
  `?rpc=` (persisted) or the build-time `NEXT_PUBLIC_RPC_URL`.
- `lib/chain.ts` — proposal/DAO reads via `@solana/spl-governance`.
- `lib/vote.ts` + `lib/governance-actions.ts` — vote/deposit txs built in
  the browser, then signed AND sent by the wallet (`signAndSendTransaction`,
  with a `signTransaction` + RPC fallback).

```sh
pnpm --filter @daofun/app test       # unit (vitest)
pnpm --filter @daofun/app test:e2e   # Playwright (next dev; no backend)
pnpm --filter @daofun/app dev        # dev server on :3210

# static export (what CI publishes to Pages):
STATIC_EXPORT=1 NEXT_PUBLIC_BASE_PATH=/<repo> pnpm exec next build  # -> app/out
```

Deployment: `.github/workflows/deploy-pages.yml` builds the static export
and publishes it to GitHub Pages on push to `main` (or via the **Run
workflow** button). Enable **Settings → Pages → Source: GitHub Actions**
once; the site lives at `https://<owner>.github.io/<repo>/`.
