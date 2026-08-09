# PLAN — perpetual post-graduation fees into the DAO treasury

Operator directive (2026-08-09): *"make a plan for tokens to graduate to
CLMM so they can gather fees into the DAOs after they graduate"*, plus
*"how we can deploy and test this end to end on devnet to make sure even
graduated tokens work as intended"*.

Today `migrate` **burns** the LP. That makes liquidity unpullable, but it
also throws the fee rights away: after graduation neither the creator nor
a DAO treasury earns anything. This plan fixes that — and the research
below changes WHICH venue we should use to do it.

---

## 1. What the DEPLOYED binaries say (evidence, not docs)

Raydium's liquidity-locking program `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE`
was dumped from mainnet (613,677 bytes) and inventoried the way D-032
inventoried the governance fork. Its **entire** instruction set is:

| File in the binary | What it does |
|---|---|
| `instructions/lock_cp_liquidity.rs` | lock **CPMM** LP tokens |
| `instructions/lock_clmm_position.rs` | lock a **CLMM** position |
| `instructions/collect_cp_fees.rs` | collect fees from locked **CPMM** liquidity |

States: `LockedCpLiquidityState`, `LockedClmmPositionState`.

**There is NO `collect_clmm_fees`.** The program can lock a CLMM position
but exposes no way to claim that locked position's fees. Only the CPMM
path has lock AND collect.

Account names lifted from the same binary confirm the shape of the CPMM
path: `fee_nft_mint`, `fee_nft_account`, `fee_nft_owner`, `locked_lp_vault`,
`locked_liquidity`, `recipient_token_0_account`, `recipient_token_1_account`,
`cp_authority`, `cp_swap_program`. So locking mints a **fee NFT**, and
whoever owns that NFT can later collect the locked position's trading fees
to arbitrary recipient token accounts.

Two more facts from the same dump, both load-bearing:

- The lock program **hard-codes the MAINNET CPMM and CLMM program ids**
  (verified by byte-searching the binary). Raydium's **devnet** CPMM id
  (`DRaycpLY…`) is absent.
- On devnet, `LockrWmn…` resolves to a **non-executable** account — the
  program is not deployed there.

## 2. Decision: CPMM + lock. CLMM is deferred.

Graduating to CLMM was the intuition (it is what stonkfun does — that
token trades in Raydium **CLMM** pools against USDC, created by their own
`goonuddt…` program). But the binary says the supported "permanent
liquidity + claimable fees" path is **CPMM**:

- **CPMM + `lock_cp_liquidity` + `collect_cp_fees`** — liquidity provably
  unwithdrawable, fees claimable forever by the fee-NFT owner. Fully
  supported by the deployed program, and it is a SMALL delta from the
  migration we have already proven end to end (GATE L1 + GATE L2).
- **CLMM** — capital-efficient, but to keep fees claimable you must hold
  the position NFT yourself and claim via `decrease_liquidity_v2` with
  `liquidity = 0`. The same signer can also decrease liquidity for real,
  so liquidity is **withdrawable by whoever holds the NFT** unless it is
  locked — and if you lock it with Raydium's program, no collect path
  exists. Choosing CLMM therefore means either weakening our headline
  guarantee or writing that machinery ourselves.

Open question worth noting: I could NOT determine who holds the position
NFT for the stonkfun token (public RPC blocked the lookup). If it sits in
a platform wallet, their liquidity is pullable in principle. Not an
accusation — an unknown, and a reason not to copy the pattern blind.

**Recommendation: ship CPMM + lock. Revisit CLMM only if concentrated
liquidity itself becomes a product requirement.**

## 3. Design

Mirror the machinery that already works for curve-phase creator fees.

**At migration** (`migrate`, extended):
1. Seed the CPMM pool exactly as today.
2. Instead of burning the LP, CPI `lock_cp_liquidity`, minting the **fee
   NFT to a program PDA** — `["fee-authority", mint]` — not to a user.
3. Record the lock + fee NFT on the curve account.

**Collecting** (`collect_graduated_fees`, new, PERMISSIONLESS):
- CPIs `collect_cp_fees` with the fee-authority PDA signing via
  `invoke_signed`, and the recipient token accounts **hard-wired to the
  coin's creator** — which for a DAO token is the treasury vault.
- Anyone may crank it; the destination is fixed by our program, exactly
  like `collect_creator_fee` today. No governance vote needed to collect.

Why a PDA and not the DAO vault directly: the vault would need to sign,
which for a Squads/governance treasury means a proposal per claim. A PDA
that can ONLY ever pay the creator gives the same custody guarantee with a
one-click crank, and keeps the keeper able to sweep automatically.

**Invariant change:** `INV-LP-BURNED` becomes `INV-LP-LOCKED` — liquidity
is still unwithdrawable by anyone including us (Raydium holds it), and we
gain a fee stream. Net strictly better; the safety property is preserved,
its proof changes.

**Cluster awareness (forced by §1):** the lock program does not exist on
devnet and rejects devnet CPMM. So the lock program is a CONFIG address:
set on mainnet → migrate locks; unset on devnet → migrate burns as today.
One binary, both clusters, and the no-withdraw guarantee holds either way.

## 4. Testing — and the honest devnet answer

The operator asked for devnet end-to-end. Devnet **cannot** cover the new
part: Raydium's lock program is not deployed there, and even a self-deployed
copy would reject devnet CPMM pools because the mainnet CPMM id is compiled
into it. Redeploying our own fork of Raydium's locker to devnet would be
testing OUR fork, not the program that will run in production — the exact
mistake D-031/D-032 exist to prevent.

So the layered strategy, strongest first:

**Layer 1 — bankrun against the REAL mainnet binaries (the primary proof).**
This is stronger than devnet for this feature, and it is what GATE L1
already does. Add `lock.so` (dumped above) to `tests/fixtures` beside
`cpmm.so`, then prove the full lifecycle in one suite:
create → buy to completion → migrate (pool + LOCK) → **swap both
directions to accrue real fees** → `collect_graduated_fees` → assert the
exact lamports/tokens land in the creator/treasury accounts, and that
lock/collect are idempotent and permissionless. Clock-warp between swaps.
Also assert the negative: no code path can decrease the locked liquidity.

**Layer 2 — devnet, for everything else (the parts devnet CAN prove).**
Program deploy, curve, migration into devnet CPMM (burn branch), trading,
the DAO ceremony (governance + Squads + VSR are all live on devnet), the
frontend and the profile/claim UI against a graduated coin. This is the
existing GATE L2 extended; it validates the plumbing around the feature.

**Layer 3 — mainnet canary (the only place the lock path can truly run).**
One real launch with a minimal raise, graduate it, swap a little, collect,
and verify the treasury balance moved. Operator go/no-go — it spends real
SOL. This becomes GATE L4.

The honest summary: **Layers 1 and 3 prove the feature; Layer 2 proves
everything around it.** Anyone claiming a devnet run proves locked-fee
collection would be wrong, and I would rather say so up front than produce
a green devnet gate that means less than it looks like.

## 5. Phases (tests before code, funds path)

- **G0 — Verification spike (blocking).** Drive `lock_cp_liquidity` and
  `collect_cp_fees` against the real binary in bankrun from the client
  side, exactly like the D-034 CPMM spike: pin the discriminators, the
  account orders, whether `recipient_token_*` is unconstrained (it must be,
  for us to hard-wire it), whether the fee-NFT owner may be a PDA, whether
  the lock is irreversible, and what it costs. Everything after this
  depends on facts this spike establishes.
- **G1 — Program.** `migrate` gains the lock branch (config-gated);
  `collect_graduated_fees` added; curve account records the fee NFT.
  Rebuild the fixture (D-029 toolchain).
- **G2 — SDK + keeper.** Builders for both, the sweep added to the
  keeper's crank so treasuries accrue without anyone clicking.
- **G3 — App.** `/profile` and the coin page surface "graduated fees
  claimable" alongside curve fees; the DAO dashboard shows the stream.
- **G4 — Gates.** Layer 1 suite green; devnet re-run; then the mainnet
  canary for operator sign-off.

## 6. Costs and risks

- Locking mints an NFT + a locked-liquidity account: a few thousand
  lamports of rent on top of today's ~0.19 SOL migration. Quantify in G0.
- The fee stream is **token_0 + token_1** (wSOL and the coin), not SOL —
  the treasury receives both; unwrapping wSOL is a keeper step.
- If Raydium ever ships `collect_clmm_fees`, revisit §2.
- The trust anchor becomes our program's upgrade authority (a future
  `collect` could be edited to redirect). Mainnet must revoke it or move
  it to governance — this is already true today, and this feature raises
  the stakes.
