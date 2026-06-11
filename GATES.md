# GATES.md — gate evidence & operator sign-off

## GATE 0a — PDA creator + permissionless collect (HARD STOP)

**Status: PASS — executed on MAINNET, 2026-06-11** (operator override
D-008: the devnet faucet was IP-rate-limited in this environment; the
operator funded a real run with ~$4.60 USDC, swapped gasless to 0.0725 SOL
via Jupiter Ultra; all liquid funds were swept back after the run —
0.0593 SOL returned to the operator's wallet).

Path used: mainnet-beta — same program IDs as devnet, production state;
stronger evidence than the spec's devnet/local-clone alternatives.

| Item | Value |
|---|---|
| mint | `E8T9KAM4tkytKe2qbMYt9ygEfz3GbjrZgMzTZt7sP1KC` |
| Squads multisig | `5572XY2dwdq2srxLBRgDeVzUkNxuGcBafn9xqStko8q8` |
| vault PDA (pump creator) | `3qnu5xeFW2vwHPK116PccxwuBTqvQqfikp73tvVR4uJA` |
| predicted native treasury (sole member, asserted on-chain) | `FmGNFAZmRdNYnf9eGwcXysZCPM7PJDMUiT2W94kHLsuo` |

Transactions (mainnet):

- multisig-create: `65XXqYszYCWidRHujrW3jRs8aZZmyTRbmKxPittemvz2ZwVere9uM7gLDS5pJhraDZNR69mfhnYXvVpYDxXKVgRM`
- rent-prefund-vaults: `2TBiz2sFgs24G1w9vmQQGMVdoBhcpTY7puAwShgrfTW5BKxa8Egmif4vR8UP2vbnn6Bp1xUC9o4V7Ur5gGsYpzQD`
- create-v2-and-dev-buy (creator = vault PDA): `2nHuT8LacbvqBveW4qegMxwRPJLZSBfWpk2xJsC5UbYmDDnstKiMKnmzth1fqZqA8hCTEgM23HZLsLXSN6dr7JsF`
- third-party-buy: `5YtVtcprYyBq2MzzXsUcYscUEKBnkMcg5bFu38mVSZ9ZJuN79B1cwPZL8SzGd5D6QQfBhGvX1W8Svn4njRdV6Qfk`
- permissionless-collect (keeper as fee-payer only; INV-2 signer-set asserted pre-send): `5ipd9HVbwDc4YtWhbujMsNviUJiDtmMqiZiRKhbEA3FLUEaF7VAacA3MjmCnKXR34bsbesQgMJRhHEAqzxRCgHMz`

**Accept criterion:** Squads vault lamports strictly increase after a
keeper-paid, creator-signature-free collect.
**Result:** `890880 -> 7271603` (+6,380,723 lamports of creator fees). PASS.

Sole-member prediction also asserted on-chain post-creation: multisig
members == [predicted native-treasury PDA], threshold == 1 (INV-7 shape).

Full machine evidence: `.gate-evidence/gate-0a-mainnet.json`.

Notes:
1. The buyer leg of the first attempt failed Solana's rent floor (the fee
   payer would have closed below the ~0.0009 SOL rent-exempt minimum) and
   was resumed with a smaller buy. Engineering consequence recorded in
   DECISIONS.md D-009 (keeper/orchestrator must maintain rent floors).
2. The 0.00727 SOL collected into the test vault is controlled by the
   not-yet-created realm for this mint (advance-derivation works both
   ways); recoverable only by standing up the governance chain. Treated as
   sunk (~$0.47).
3. Cleanup: test tokens sold back to the curve, token + USDC ATAs closed
   (rent reclaimed), all three role wallets swept to the operator wallet
   `2aJKQetcRJDVcbXikYUUuPZByypPV46LWdCSm48sWzYk`.

Operator sign-off: ______ (run was operator-funded and operator-directed)

## GATE 0b — Token-2022 on curve (soft)

Not run. Note D-004: pump `createV2` mints are already Token-2022 (the
mainnet GATE 0a token is a live example); the open question narrows to
transfer-fee extensions.

## GATE 0c — Fee shares at launch for PDA creator (soft)

Not run. Risk flag D-007: `createFeeSharingConfig` requires the creator as
payer/signer, which a PDA creator cannot satisfy in a plain launch tx.
