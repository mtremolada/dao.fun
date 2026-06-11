# GATES.md — gate evidence & operator sign-off

## GATE 0a — PDA creator + permissionless collect (HARD STOP)

**Status:** BLOCKED ON FUNDING (not a gate failure) — script ready
(`pnpm gate:0a`), devnet RPC healthy, but the public faucet returned
`429 airdrop limit` for this execution environment's IP on 2026-06-11
(retried 5x with exponential backoff per wallet; alternate keyless RPC
airdrop endpoints also unavailable). No `solana-test-validator` exists in
this container, so the spec's local-clone fallback path is not available
here either.

Options (operator):
1. Retry in a later session — the faucet limit is per-day; wallets are
   regenerated per-container (devnet keys are disposable and never
   committed, per Section 11).
2. Send ~1 SOL of devnet SOL (faucet.solana.com) to each of deployer /
   keeper / buyer from `.wallets/manifest.json` of the live session, then
   tell the agent to continue.

Evidence will be appended here verbatim from `.gate-evidence/gate-0a.json`
(tx signatures, balances before/after) once the run completes.

Accept criterion: Squads vault lamports strictly increase after a
keeper-paid, creator-signature-free collect.

Operator sign-off: ______

## GATE 0b — Token-2022 on curve (soft)

Not run. Note D-004: pump `createV2` mints are already Token-2022; the open
question narrows to transfer-fee extensions.

## GATE 0c — Fee shares at launch for PDA creator (soft)

Not run.
