# Deploying `proposal-gate` to mainnet (turnkey — pending a funded wallet)

> **Status: NOT YET DEPLOYED.** Guarded mode is fully built, wired, and
> proven on the real governance binary in bankrun (`stage3-guarded`,
> `stage3-guarded-spike`), but it CANNOT function until this program is live
> on the cluster the app reads. Until then the UI keeps Guarded unselectable
> (`NEXT_PUBLIC_GUARDED_ENABLED` unset) — selecting it without the program
> on-chain would brick the DAO at the gate-init step and burn the launcher's
> SOL. The blocker is operational, not code: a funded deployer + an
> upgrade-authority decision (both yours, per spec Section 11).

## What you need first

1. **A funded mainnet deployer keypair** — ~3 SOL (program-rent for the
   `programdata` account; a temporary buffer of the same size is also needed
   during deploy and is refunded). Path passed as `DEPLOYER_KEYPAIR`.
2. **An upgrade-authority decision:**
   - **(A) Upgradeable** — pass `UPGRADE_AUTHORITY=<a pubkey you control>`
     (ideally a multisig). Lets you patch a bug; that key controls the
     program every Guarded DAO routes its treasury through, so it must NOT
     be a hot/throwaway key (Section 11). **Recommended for unaudited code.**
   - **(B) Immutable** — pass `FINAL=1` (no upgrade authority ever). Cleanest
     trust story; a bug becomes permanent.
3. **Toolchain** (D-029): Anza `solana-cli` 4.0.1 + `cargo-build-sbf` 4.0.0,
   platform-tools v1.53. In this environment the built-in downloader fails on
   the egress proxy CA — curl-fetch `platform-tools-linux-x86_64.tar.bz2` into
   `~/.cache/solana/v1.53/platform-tools/` first.
4. **Honest risk flag:** the program is **unaudited**. The spec's hard rule is
   no custom program on mainnet before an external audit (GATE 3). Deploying
   now is a deliberate operator override (D-034) — your call, recorded.

## One-shot

```sh
DEPLOYER_KEYPAIR=~/keys/gate-deployer.json \
UPGRADE_AUTHORITY=<your-multisig-pubkey> \
RPC_URL=https://api.mainnet-beta.solana.com \
  scripts/deploy-gate.sh
```

(For an immutable deploy use `FINAL=1` instead of `UPGRADE_AUTHORITY`.)

The script generates a fresh program keypair, pins `declare_id!` to it, builds
the SBF artifact, deploys, and prints the **program ID**.

## After deploy — flip Guarded on (one variable + one constant)

1. Pin the deployed ID in `packages/sdk/src/constants.ts`:
   `export const GATE_PROGRAM_ID = new PublicKey("<deployed id>");`
2. Rebuild the bankrun fixture so the test suite runs at the deployed id:
   ```sh
   cd programs && cargo-build-sbf --manifest-path proposal-gate/Cargo.toml \
     && gzip -c target/deploy/proposal_gate.so > ../tests/fixtures/proposal_gate.so.gz
   ```
   then `pnpm test:integration` (stage3-guarded must stay green).
3. Set the repo variable **`NEXT_PUBLIC_GUARDED_ENABLED=1`** (Settings →
   Secrets and variables → Actions → Variables). The deploy-pages workflow
   already reads it.
4. Push / re-run the Pages deploy. Guarded is now selectable and works.

## Never commit

`programs/target/` is gitignored — the program-id keypair and any deployer key
live only on your machine. No private key is ever committed or logged.
