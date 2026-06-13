# DEPLOY.md — shipping the decentralized front end (D-033)

The app is a **static export**: no server, no key, no custody path on the
host. The build output is a directory (`app/out`) of plain HTML/JS/CSS.
Reads, verification (INV-9 recomputed in-browser), voting, deposits, and the
full launch ceremony all run client-side against an RPC the user chooses.

## 1. Build the static bundle

```sh
pnpm install
pnpm --filter @daofun/sdk build         # the app consumes the SDK's dist
# build-time config (inlined into the static bundle):
export NEXT_PUBLIC_RPC_URL=https://<your-mainnet-rpc>     # default RPC; users can override in-app
export NEXT_PUBLIC_PROTOCOL_TREASURY=<pubkey>            # optional: launch-fee recipient
export NEXT_PUBLIC_LAUNCH_FEE=0                          # optional: launch fee (lamports)
# NEXT_PUBLIC_BASE_PATH= (leave empty for IPFS subdomain gateways / a domain root)
pnpm --filter @daofun/app build         # -> app/out
```

Verify the gate before shipping:

```sh
pnpm test:unit && pnpm test:integration   # 249 unit + 21 integration (real binaries)
pnpm lint && pnpm exec tsc -p tsconfig.json --noEmit
```

## 2. Deploy (most-decentralized first)

### IPFS (recommended — fully decentralized)

```sh
# with the w3 CLI (Storacha / web3.storage):
npx @web3-storage/w3cli up app/out
# or Pinata:
npx pinata-cli upload app/out
```

Pin the resulting **CID** and serve it through an **IPFS subdomain
gateway** — e.g. `https://<cid>.ipfs.dweb.link/` or your own gateway, or an
ENS/DNSLink name pointing at the CID. Subdomain gateways serve the CID at
the path root, so the bundle's absolute `/_next/...` asset URLs resolve
correctly with no extra config.

> Path-style gateways (`https://gw/ipfs/<cid>/...`) and subdirectory hosts
> need a base path: rebuild with `NEXT_PUBLIC_BASE_PATH=/ipfs/<cid>` (or
> `/<subdir>`). Subdomain gateways and a domain root need it empty.

### Any static host (Vercel / Netlify / Cloudflare Pages / S3 / GitHub Pages)

Serve the `app/out` directory as static files. For a subpath host (e.g.
GitHub Pages at `/<repo>`), set `NEXT_PUBLIC_BASE_PATH=/<repo>` before
`pnpm --filter @daofun/app build`.

## 3. CI

`.github/workflows/deploy.yml` builds the static export and uploads `app/out`
as a workflow artifact on every push to the working branch and on manual
dispatch. If you add a `PINATA_JWT` repository secret it also pins the build
to IPFS and prints the CID in the job summary — no other secret is required,
and none is needed for the artifact path.

## What's verified vs. what you confirm with a wallet

Verified in CI / this repo: the transaction **builders** against the real
mainnet program binaries (bankrun), the launch orchestrator logic offline,
the byte-exact vendored hash, and that the static bundle builds. The
**live** wallet/RPC execution of vote, deposit, and the multi-step launch is
exercised for the first time against a real wallet + RPC at deploy time —
smoke-test each with a funded wallet after the first deploy.
