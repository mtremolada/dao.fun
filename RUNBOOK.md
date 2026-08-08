# RUNBOOK — public devnet launchpad

Operator playbook for taking the launchpad live on devnet as a public dapp
(Vercel frontend + Railway backend). Everything the code needs is built and
tested; this is the deploy + operate guide. Commands assume the repo root and
the Solana CLI on PATH:

```
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
```

Toolchain pins (D-035): solana-cli 4.1.x / cargo-build-sbf 4.1.0 /
platform-tools v1.54 / anchor-lang 0.30.1. The `raydium-cpmm-cpi` graduation
crate is pinned by git rev on the `anchor-0.30.1` branch.

---

## D — Deploy the program to devnet + GATE L2

### D1. Fund a deployer (~7 devnet SOL; peak need ~6)

A ~421 KB program costs ~3.0 SOL net rent, ~6 SOL peak (the buffer and
programdata coexist during deploy). Airdrop through a keyed RPC — the public
endpoint rate-limits datacenter IPs:

```
solana-keygen new -o .wallets/deployer.json          # keep OUTSIDE git; .wallets is gitignored
solana config set --url https://devnet.helius-rpc.com/?api-key=$HELIUS_KEY --keypair .wallets/deployer.json
for i in $(seq 1 4); do solana airdrop 2; sleep 5; done   # 2 SOL/request; repeat until ~7
```
Backstop if airdrops throttle: https://faucet.solana.com (GitHub sign-in raises
the limit).

### D2. Mint the real program id and build

The committed `declare_id!` is a scaffold. Mint the real id ONCE and keep the
keypair forever (a closed program id can never be reused):

```
solana-keygen grind --starts-with dao:1              # optional vanity; or: solana-keygen new -o .wallets/launchpad-program.json
# put the resulting pubkey in programs/launchpad-curve/src/lib.rs declare_id!(...)
# and packages/sdk/src/launchpad/constants.ts LAUNCHPAD_PROGRAM_ID
export CARGO_NET_GIT_FETCH_WITH_CLI=true
cargo-build-sbf --manifest-path programs/launchpad-curve/Cargo.toml
gzip -9 -c programs/target/deploy/launchpad_curve.so > tests/fixtures/launchpad_curve.so.gz
rm -f tests/fixtures/launchpad_curve.so              # or the stale .so keeps loading in tests
pnpm --filter @daofun/sdk build && npx vitest run tests/launchpad-curve.integration.test.ts  # re-prove after the id change
```
**Back up `.wallets/launchpad-program.json` off-box.** Losing it loses the
address and the upgrade authority.

### D3. Deploy

```
solana program deploy \
  --program-id .wallets/launchpad-program.json \
  --keypair .wallets/deployer.json \
  -u https://devnet.helius-rpc.com/?api-key=$HELIUS_KEY \
  --with-compute-unit-price 10000 --max-sign-attempts 15 --use-rpc \
  programs/target/deploy/launchpad_curve.so
```
If it fails on blockhash expiry mid-upload, the CLI prints a recovery seed:
`solana-keygen recover` it and resume with `--buffer <recovered>`. Reclaim
orphaned buffers with `solana program show --buffers` / `solana program close
--buffers`. **Never** `solana program close` the program id itself.

Publish the IDL so explorers decode instructions (permissionless — claim it
first): `anchor idl init <PROGRAM_ID> -f <idl.json>` (Anchor 0.30 is a manual
step; generate the IDL from the program or hand-author one).

### D4. Initialize the config (devnet-scaled profile)

```
LAUNCHPAD_PROGRAM_ID=<id> \
RPC_URL=https://devnet.helius-rpc.com/?api-key=$HELIUS_KEY \
AUTHORITY_KEYPAIR=.wallets/deployer.json \
FEE_RECIPIENT=<your devnet treasury pubkey> \
npx tsx scripts/launchpad-init-devnet.ts
```
This sends `initialize_config` with the DEVNET profile (initial_virtual_sol
scaled ÷30 so a full curve completes in ~2.83 SOL — one faucet cycle) and the
canonical devnet Raydium addresses (`DRaycpLY18…` / `5MxLgy…` / `3oE58BKV…` —
NOT the stale `CPMDWBwJ…` set, which charges 1 SOL and is invisible to
Raydium's devnet UI). It reads the config back to verify.

### D5. GATE L2 — end-to-end on devnet

Launch a coin, buy it to completion, crank `migrate`, and verify the real
Raydium pool + the indexer decoding real events. Evidence → GATES.md.

```
npx tsx scripts/gate-l2-devnet.ts    # create → dev-buy → buys to completion → migrate → assert pool + LP burned
```
Assert on devnet: pool owned by `DRaycpLY18…`, `lp_mint.supply == 0`, the
runtime-read create-pool fee matched the escrow, the pool is indexed by
`api-v3-devnet.raydium.io/pools/info/list`, and the indexer (run from a zero
cursor) reconciles every event with chain — the one thing bankrun can't prove.

Verify-at-first-use for the DAO path: confirm the GovER5 fork / Squads / pump
programs behave on devnet before wiring DAO writes; if divergent, ship the DAO
pages read-only until resolved (open item, not a launchpad blocker).

---

## E — Public hosting (Railway backend + Vercel frontend)

### E1. Railway (one always-on service: API + indexer + keeper)

- Hobby plan ($5/mo). Create a service from this repo, add a **volume mounted at
  `/data`** (holds the sqlite index), set the healthcheck path `/health`, and
  **turn Serverless/sleep OFF** so the poller never sleeps.
- Build: `pnpm install --frozen-lockfile && pnpm -r build`
  Start: `node packages/backend/dist/server.js`
- SSE: the hub heartbeats every 25 s (under Railway's 5-min no-data cutoff) and
  the browser's EventSource auto-reconnects at Railway's 15-min connection cap.
- The browser talks to the Railway origin **directly** (`NEXT_PUBLIC_API_URL` +
  CORS locked to the Vercel origin) — do NOT proxy SSE through Vercel rewrites
  (120 s cut + post-April-2026 rewrite caching).

**Railway env:**

| Var | Value |
|---|---|
| `PORT` | (Railway injects) |
| `CLUSTER` | `devnet` |
| `RPC_URL` | `https://devnet.helius-rpc.com/?api-key=<KEY_INDEXER>` |
| `RPC_PROXY_UPSTREAM` | `https://devnet.helius-rpc.com/?api-key=<KEY_PROXY>` (a SECOND key, so browser abuse can't starve the indexer) |
| `LAUNCHPAD_PROGRAM_ID` | from D2 |
| `LAUNCHPAD_STORE` | `sqlite:/data/launchpad.db` |
| `ARTIFACT_STORE` | `sqlite:/data/artifacts.db` |
| `CORS_ORIGINS` | `https://<project>.vercel.app` (exact origin) |
| `METADATA_DIR` | `/data/meta` |
| `PUBLIC_BASE_URL` | `https://<service>.up.railway.app` |
| `KEEPER_KEYPAIR` | base58 or JSON array, funded ~2 devnet SOL (fee-payer only) |
| `AIRDROP_ENABLED` / `AIRDROP_SOL` / `AIRDROP_COOLDOWN_HOURS` / `AIRDROP_DAILY_CAP` | `1` / `1` / `8` / `200` |
| `INDEXER_POLL_MS` | `4000` (fits Helius free 1M credits/mo) |
| `SSE_HEARTBEAT_MS` | `25000` |

Optionally `pnpm add -w sharp` (or in packages/backend) to enable 512×512 webp
metadata downscaling — the uploader falls back to storing the original if it's
absent, so it's not required.

### E2. Vercel (frontend)

- Import the personal repo (Hobby git integration works for personal repos;
  a no-value devnet demo is non-commercial). Root directory `app/`.
- Build: `pnpm --filter @daofun/sdk build && pnpm exec next build`.
  Leave `STATIC_EXPORT` / `NEXT_PUBLIC_BASE_PATH` unset (SSR mode → security
  headers + generateMetadata apply).

**Vercel env (build-time):**

| Var | Value |
|---|---|
| `NEXT_PUBLIC_CLUSTER` | `devnet` |
| `NEXT_PUBLIC_API_URL` | `https://<service>.up.railway.app` |
| `NEXT_PUBLIC_RPC_URL` | `https://<service>.up.railway.app/rpc/devnet` (browser RPC via our proxy) |
| `NEXT_PUBLIC_RPC_FALLBACK_URL` | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_LAUNCHPAD_PROGRAM_ID` | from D2 |

### E3. Operator checklist

1. Two Helius free keys (indexer, proxy); set dashboard allowed-domains where
   available on free tier.
2. Keypairs: deployer (~7 SOL, D1), keeper (~2 SOL), program-id + upgrade
   authority — store the last two OFF-box.
3. Railway service + `/data` volume + env (E1), sleep OFF.
4. Vercel project + env (E2).
5. Retire GitHub Pages: it serves a stale mainnet real-SOL flow from `main` —
   disable Pages once the Vercel URL is live (leave a redirect if inbound links
   matter).
6. **Phantom domain review:** after the first live tx, submit Phantom's
   domain-review form (docs.phantom.com/developer-powertools/domain-and-transaction-warnings).
   Expect a "new/unreviewed" banner for a few days. Known caveat: `*.vercel.app`
   is a drainer-phishing hotspot with elevated false-positive risk — a ~$10/yr
   custom domain is the mitigation; pre-warn testers that Phantom devnet
   warnings ("reverted during simulation") are expected and safe.
7. UptimeRobot (free) on the Vercel URL + the Railway `/health`.
8. Phone smoke-test inside Phantom's in-app browser with Testnet Mode → Solana
   Devnet (mobile Safari/Chrome can't reach extensions).

---

## Operate

- **Health:** `GET /health` returns the indexed slot + SSE client count.
- **Devnet restarts** preserve account state (2025–26 incidents were snapshot
  hard-forks), but the indexer is idempotent with a re-scan window; expect
  churn during the Alpenglow window (Aug–Oct 2026).
- **Helius budget:** 4 s polling ≈ 650 k credits/mo; two keys isolate the
  browser proxy from the indexer. Drop `INDEXER_POLL_MS` or move to WSS
  logsSubscribe if the pool tightens.
- **Raydium drift watch:** the CPMM program is upgradeable (~quarterly). If
  either cluster's deploy slot changes (devnet 430,784,616 / mainnet
  425,801,539), re-dump the fixture and re-run the graduation suite. Migration
  reads `create_pool_fee` live, so a fee change needs no code change.
- **Program upgrade:** ship a tolerant indexer FIRST, only ADD events (never
  rename one), then upgrade; `solana program deploy` with the same program id.
- **Keeper/deployer top-up:** watch balances; keeper only pays fees, deployer
  only for upgrades.
