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
inventoried the governance fork. It publishes an **on-chain Anchor IDL**
(account `HzLkUWn57cdtyQNQLJpyu2EPF8qQAiGt4iuiEo1XnEFK`, zlib-compressed,
name `raydium_liquidity_locking` v0.1.0). Its **entire** instruction set:

| Instruction | Args | What it does |
|---|---|---|
| `lock_cp_liquidity` | `lp_amount: u64`, `with_metadata: bool` | lock **CPMM** LP tokens, mint a fee NFT |
| `collect_cp_fees` | `fee_lp_amount: u64` | collect fees from locked **CPMM** liquidity |
| `lock_clmm_position` | `with_metadata: bool` | lock a **CLMM** position, mint a fee NFT |
| `collect_clmm_fees_and_rewards` | *(none)* | collect fees + rewards from a locked **CLMM** position |

States: `LockedCpLiquidityState`, `LockedClmmPositionState`.
Event: `SettleCpFeeEvent`.

> **Correction (supersedes an earlier draft of this file).** A
> strings-based sweep of the binary surfaced only three instruction
> source-paths and I wrote "there is NO `collect_clmm_fees`". The IDL
> disproves that: `collect_clmm_fees_and_rewards` exists, takes no args,
> and has `fee_nft_owner` (signer) plus `recipient_token_0_account` /
> `recipient_token_1_account`. **Both** venues have lock AND collect.
> §2's recommendation stands, but it now rests on its real merits rather
> than on a capability CLMM turned out to have.

Both collect paths share the same shape, and it is the shape our design
needs: `fee_nft_owner` is the **only** signer, and the recipient token
accounts are separate, writable, caller-supplied accounts. So locking
mints a **fee NFT**, and whoever owns that NFT can later sweep the locked
position's trading fees to token accounts of their choosing.

Account lists (0-indexed, from the IDL) worth pinning here because the
design depends on them:

- `lock_cp_liquidity`: `[0] authority`, `[1] payer(mut,signer)`,
  `[2] liquidity_owner(signer)`, `[3] fee_nft_owner` **(not a signer —
  so it may be any address, including a PDA)**,
  `[4] fee_nft_mint(mut,signer)` **(a fresh keypair must co-sign the
  outer tx)**, `[5] fee_nft_account(mut)`, `[6] pool_state`,
  `[7] locked_liquidity(mut)`, `[8] lp_mint`, `[9] liquidity_owner_lp(mut)`,
  `[10] locked_lp_vault(mut)`, `[11] token_0_vault(mut)`,
  `[12] token_1_vault(mut)`, `[13] metadata_account(mut)`, `[14] rent`,
  `[15] system`, `[16] token`, `[17] ATA`, `[18] metadata_program`.
- `collect_cp_fees`: `[0] authority`, `[1] fee_nft_owner(signer)`,
  `[2] fee_nft_account`, `[3] locked_liquidity(mut)`,
  `[4] cp_swap_program`, `[5] cp_authority`, `[6] pool_state(mut)`,
  `[7] lp_mint(mut)`, `[8] recipient_token_0_account(mut)`,
  `[9] recipient_token_1_account(mut)`, `[10] token_0_vault(mut)`,
  `[11] token_1_vault(mut)`, `[12] vault_0_mint`, `[13] vault_1_mint`,
  `[14] locked_lp_vault(mut)`, `[15] token`, `[16] token_2022`,
  `[17] memo`.

The IDL carries no PDA seed metadata and no error table; the binary's
string table supplies the seeds (`lock_cp_authority_seed`,
`locked_liquidity`). G0 measures the rest against the binary — an IDL is
an interface description, not proof of the constraints behind it.

Two more facts from the same dump, both load-bearing:

- The lock program **hard-codes the MAINNET CPMM and CLMM program ids**
  (verified by byte-searching the binary). Raydium's **devnet** CPMM id
  (`DRaycpLY…`) is absent.
- On devnet, `LockrWmn…` resolves to a **non-executable** account — the
  program is not deployed there.

## 2. Decision: CPMM + lock. CLMM is deferred.

Graduating to CLMM was the intuition (it is what stonkfun does — that
token trades in Raydium **CLMM** pools against USDC, created by their own
`goonuddt…` program). Both venues are *capable*: lock-and-collect exists
for each. The choice is therefore about cost, risk, and what we can prove
— not about capability.

- **CPMM + `lock_cp_liquidity` + `collect_cp_fees`.** Liquidity provably
  unwithdrawable (there is no `unlock`), fees claimable forever by the
  fee-NFT owner. A position is **full-range by construction**, so it earns
  on every trade forever with no maintenance. And it is a SMALL delta from
  a migration we have already proven end to end (GATE L1 + GATE L2) — the
  pool, its vaults, its LP mint and their derivations are already
  exercised against the deployed CPMM binary.
- **CLMM + `lock_clmm_position` + `collect_clmm_fees_and_rewards`.**
  Capital-efficient, and lockable with a collect path. But a CLMM position
  has a tick range: once price leaves it, the position earns **nothing**
  until price returns, and a *locked* position cannot be rebalanced —
  that is the failure mode for a launchpad coin, whose whole story is
  price moving a long way from where it graduated. Buying that back means
  either a full-range CLMM position (which throws away the only reason to
  choose CLMM) or an active rebalancer we would have to build, own, and
  fund. `collect_clmm_fees_and_rewards` also drags in tick arrays,
  protocol positions and reward vaults — a much larger account list and CU
  bill inside a CPI, and a second migration path to prove from scratch.

So: CPMM wins on total cost to ship and on the guarantee holding
unattended forever. CLMM is not ruled out on capability, and if
concentrated liquidity ever becomes a product requirement it is a
tractable second rail — the lock program supports it.

Open question worth noting: I could NOT determine who holds the position
NFT for the stonkfun token (public RPC blocked the lookup). If it sits in
a platform wallet, their liquidity is pullable in principle. Not an
accusation — an unknown, and a reason not to copy the pattern blind.

**Recommendation: ship CPMM + lock. Revisit CLMM only if concentrated
liquidity itself becomes a product requirement.**

## 3. Design — every assumption now measured (G0, 2026-08-09)

`tests/launchpad-lock-verify.integration.test.ts` (8 tests) drives the real
`LockrWmn…` binary in bankrun. It is green, and it moved three things.
The design below is what survived contact with it.

**At migration** (`migrate`, extended):
1. Seed the CPMM pool exactly as today.
2. Instead of burning the LP, CPI `lock_cp_liquidity`, minting the **fee
   key to a program PDA** — `["fee-authority", mint]` — not to a user.
   `fee_nft_owner` is not a signer, so this needs no cooperation from it.
3. `fee_nft_mint` is the one slot that MUST sign, and **G0 proved a PDA can
   fill it** (verified through Squads' ephemeral signers, which are PDAs the
   Squads program signs for — structurally identical to our program signing
   `["fee-nft", mint]`). So `migrate` stays single-signer: no throwaway
   keypair rides along, and the fee key's address is derivable from the coin
   mint rather than random.
4. Record the lock on the curve account anyway — cheap, and it lets clients
   confirm a lock without re-deriving.

**Collecting** (`collect_graduated_fees`, new, PERMISSIONLESS):
- CPIs `collect_cp_fees` with the fee-authority PDA signing via
  `invoke_signed`, and the recipient token accounts **hard-wired to the
  coin's creator** — which for a DAO token is the treasury vault.
- Anyone may crank it; the destination is fixed by our program, exactly
  like `collect_creator_fee` today. No governance vote needed to collect.
- G0 confirms both halves: the recipients are **unconstrained** (a payout
  landed in a non-ATA account owned by an unrelated PDA), and the fee key
  is the **sole** authority (a thief signing for themselves is refused,
  whether they point at their own empty NFT account or at the real one).
- `fee_lp_amount = u64::MAX` claims everything. Re-cranking with nothing
  accrued is a no-op, not an error — safe for an unconditional keeper loop.

Why a PDA and not the DAO vault directly: the vault would need to sign,
which for a Squads/governance treasury means a proposal per claim. A PDA
that can ONLY ever pay the creator gives the same custody guarantee with a
one-click crank, and keeps the keeper able to sweep automatically. (G0 also
proved the vault-signs-directly variant works, via a Squads vault PDA
collecting into its own token accounts — so that door stays open.)

**Invariant change:** `INV-LP-BURNED` becomes `INV-LP-LOCKED`. State it
carefully, because the naive version is false: **`locked_lp_amount` goes
DOWN over time.** CPMM keeps the LP share of every trade fee inside the
vaults, so k grows and each LP token redeems for more; collecting burns
exactly the slice of LP whose redemption value equals that growth. G0
asserts the bookkeeping is exact (`Δlocked == Δclaimed`, and `last_k` never
decreases). So the guarantee is *the deposited value never leaves the
pool*, not *the LP token count is constant* — and nobody, including us,
has any instruction that withdraws it.

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
already does. `raydium_lock.so.gz` now sits in `tests/fixtures` beside
`cpmm.so` (pinned to deploy slot 362,025,476 in `fixture-slots.json`) and
G0 already exercises the lock program directly. G1 extends that to the full
lifecycle in one suite:
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

- **G0 — Verification spike. ✅ DONE (2026-08-09), 8/8 green**
  (`tests/launchpad-lock-verify.integration.test.ts`). Every question this
  phase existed to answer came back the way the design needed:

  | Question | Answer, measured on the binary |
  |---|---|
  | Discriminators | `lock_cp_liquidity` = `[216,157,29,78,38,51,31,26]`, `collect_cp_fees` = `[8,30,51,199,209,184,247,133]` — both reproduce as `sha256("global:<name>")[..8]` |
  | Seeds | authority `["lock_cp_authority_seed"]` → `3f7Gc…`; record `["locked_liquidity", fee_nft_mint]`; locked LP vault = `ATA(authority, lp_mint)` |
  | Account orders | 19 / 18 accounts, IDL order, accepted verbatim |
  | Can the fee key go to a PDA? | **Yes** — `fee_nft_owner` never signs at lock time |
  | Can a PDA collect? | **Yes** — proven via a Squads vault PDA `invoke_signed` |
  | Can `fee_nft_mint` be a PDA? | **Yes** — so `migrate` needs no extra keypair signature |
  | Are recipients constrained? | **No** — a payout landed in a non-ATA account owned by an unrelated PDA |
  | Can anyone else collect? | **No** — fee-key ownership is enforced, both spoofing attempts refused |
  | Reversible? | **No** — no unlock/withdraw/close/decrease entrypoint exists (Anchor rejects each discriminator with `InstructionFallbackNotFound`), and CPMM `withdraw` on the locked vault is refused |
  | Idempotent? | Yes — a second collect with nothing accrued pays 0 and does not fail |
  | Cost | **23,328,400 lamports** with metadata (8,212,800 without; the difference is 5,115,600 rent + Metaplex's flat 10,000,000 create fee) |
  | Compute | lock **166,769 CU**, collect **103,408 CU** |
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

- **Migration gets ~12% more expensive: 0.0233 SOL on top of today's
  0.192156720 SOL** (measured in G0, metadata on). Two thirds of the
  increase is Metaplex's flat 0.01 SOL create-metadata fee; turning
  `with_metadata` off would save 0.0151 SOL but leave the fee key nameless
  in wallets. The curve's migration reserve has to grow by the full amount
  or graduations strand — that number is a G1 change, not a rounding note.
- The fee stream is **token_0 + token_1** (wSOL and the coin), not SOL —
  the treasury receives both; unwrapping wSOL is a keeper step.
- CLMM stays available as a second rail (§2); revisit if concentrated
  liquidity becomes a requirement.
- The trust anchor becomes our program's upgrade authority (a future
  `collect` could be edited to redirect). Mainnet must revoke it or move
  it to governance — this is already true today, and this feature raises
  the stakes.
