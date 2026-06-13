#!/usr/bin/env bash
#
# Turnkey mainnet deploy of the proposal-gate program (Guarded mode, spec 6.9).
# Pending an operator-funded wallet — see programs/proposal-gate/DEPLOY.md.
#
# Inputs (env):
#   DEPLOYER_KEYPAIR   path to a funded mainnet keypair (~3 SOL).            [required]
#   UPGRADE_AUTHORITY  base58 pubkey you control (multisig recommended).    [A]
#   FINAL=1            deploy immutable (no upgrade authority).             [B]
#   RPC_URL            cluster RPC. Default: https://api.mainnet-beta.solana.com
#   GATE_KEYPAIR       reuse an existing program keypair (else a fresh one
#                      is generated; the pubkey becomes the program ID).
#
# It pins declare_id! to the program key, builds the SBF artifact, and deploys.
# It does NOT touch the SDK constant or the Pages flag — that's the explicit
# post-deploy step in DEPLOY.md (so the deploy and the go-live are separate,
# reviewable actions). No private key is printed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
LIB="$ROOT/programs/proposal-gate/src/lib.rs"
DEPLOY_DIR="$ROOT/programs/target/deploy"
SO="$DEPLOY_DIR/proposal_gate.so"

if [[ -z "${DEPLOYER_KEYPAIR:-}" ]]; then
  echo "ERROR: set DEPLOYER_KEYPAIR to a funded mainnet keypair (~3 SOL)." >&2
  exit 1
fi
if [[ -z "${UPGRADE_AUTHORITY:-}" && -z "${FINAL:-}" ]]; then
  echo "ERROR: set UPGRADE_AUTHORITY=<pubkey you control> (upgradeable) OR FINAL=1 (immutable)." >&2
  exit 1
fi

for bin in solana solana-keygen cargo-build-sbf; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' not on PATH — install the toolchain (DEPLOY.md / D-029)." >&2; exit 1; }
done

mkdir -p "$DEPLOY_DIR"
GATE_KEYPAIR="${GATE_KEYPAIR:-$DEPLOY_DIR/proposal_gate-keypair.json}"
if [[ ! -f "$GATE_KEYPAIR" ]]; then
  echo "→ generating a fresh program keypair at $GATE_KEYPAIR"
  solana-keygen new --no-bip39-passphrase --silent -o "$GATE_KEYPAIR"
fi
GATE_ID="$(solana address -k "$GATE_KEYPAIR")"
echo "→ program id: $GATE_ID"

echo "→ pinning declare_id! to $GATE_ID"
# portable in-place sed (GNU + BSD)
sed -i.bak -E "s/declare_id!\\(\"[^\"]*\"\\)/declare_id!(\"$GATE_ID\")/" "$LIB" && rm -f "$LIB.bak"

echo "→ building SBF artifact"
( cd "$ROOT/programs" && cargo-build-sbf --manifest-path proposal-gate/Cargo.toml )
[[ -f "$SO" ]] || { echo "ERROR: build produced no $SO" >&2; exit 1; }

AUTH_ARGS=()
if [[ -n "${FINAL:-}" ]]; then
  AUTH_ARGS+=(--final)
  echo "→ deploying IMMUTABLE (no upgrade authority)"
else
  AUTH_ARGS+=(--upgrade-authority "$UPGRADE_AUTHORITY")
  echo "→ deploying upgradeable; authority = $UPGRADE_AUTHORITY"
fi

solana program deploy \
  --url "$RPC_URL" \
  --keypair "$DEPLOYER_KEYPAIR" \
  --program-id "$GATE_KEYPAIR" \
  "${AUTH_ARGS[@]}" \
  "$SO"

echo ""
echo "✅ deployed proposal-gate at: $GATE_ID"
echo "Next (DEPLOY.md): pin GATE_PROGRAM_ID=$GATE_ID in packages/sdk/src/constants.ts,"
echo "rebuild tests/fixtures/proposal_gate.so.gz, set repo var NEXT_PUBLIC_GUARDED_ENABLED=1, redeploy Pages."
