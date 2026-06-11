/**
 * Fixed action menu — spec 6.8. Safe preset builders whose output goes
 * through the ExecutionAdapter into proposals. Every builder validates its
 * bounds at build time AND constructs instructions that touch no accounts
 * outside the declared set; on-chain enforcement of the menu arrives with
 * the Stage 3 proposal-gate.
 *
 * MVP ships `grant`, `burn`, and `buyback` (curve venue). Still blocked on
 * open (verify) items (DECISIONS.md): provideLiquidity / post-graduation
 * buyback on PumpSwap pool ixs, distribute on the merkle distributor
 * program ID, setParam on the whitelisted-param registry.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  type BondingCurve,
  type Global,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";

/** Default rent-exempt floor for a 0-data account; callers may refresh it. */
export const DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n;

export interface GrantParams {
  vault: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  rentFloorLamports?: bigint;
}

export function buildGrantIxs(p: GrantParams): TransactionInstruction[] {
  if (p.lamports <= 0n) {
    throw new Error("grant: lamports must be positive");
  }
  if (p.lamports > p.vaultBalanceLamports) {
    throw new Error(
      `grant: ${p.lamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  if (p.vaultBalanceLamports - p.lamports < floor) {
    throw new Error(
      `grant: would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }
  return [
    SystemProgram.transfer({
      fromPubkey: p.vault,
      toPubkey: p.recipient,
      lamports: p.lamports,
    }),
  ];
}

export interface BurnParams {
  vault: PublicKey;
  mint: PublicKey;
  amount: bigint;
  /** Treasury token balance at build time. */
  vaultTokenBalance: bigint;
  tokenProgram: PublicKey;
}

export interface BuybackParams {
  /** The DAO's Squads vault — the buying `user`; signs via the custody chain. */
  vault: PublicKey;
  /** The DAO's own token (v2 mints are Token-2022, D-004). */
  mint: PublicKey;
  /** SOL to spend on the buy (pump fees come on top — see headroom). */
  solLamports: bigint;
  /** Vault balance at proposal build time (re-checked by simulation, 12.3). */
  vaultBalanceLamports: bigint;
  /** Live pump state at build time (the chain reader / orchestrator supplies it). */
  global: Global;
  bondingCurveAccountInfo: AccountInfo<Buffer>;
  bondingCurve: BondingCurve;
  /** Buy slippage percent (pump-sdk convention); default 5. */
  slippagePercent?: number;
  rentFloorLamports?: bigint;
}

// pump's buy fee (protocol + creator bps) is paid on top of solAmount;
// budget ~2% headroom plus the floor when validating spendability.
const BUYBACK_FEE_HEADROOM_BPS = 200n;

/**
 * Buyback on the token's OWN bonding curve (spec 6.8: buyback is pinned to
 * the token's curve/pool — no external routing). The vault is the buying
 * user; the ExecutionAdapter chain provides its signature. The vault's
 * token ATA must already exist — ATA creation is permissionless and MUST
 * happen outside the proposal to keep the execute insert under the D-019
 * size ceiling. Post-graduation (PumpSwap) buyback stays blocked on the
 * pool-ix verify item.
 */
export async function buildBuybackIxs(
  p: BuybackParams,
): Promise<TransactionInstruction[]> {
  if (p.solLamports <= 0n) {
    throw new Error("buyback: solLamports must be positive");
  }
  if (p.solLamports > p.vaultBalanceLamports) {
    throw new Error(
      `buyback: ${p.solLamports} exceeds vault balance ${p.vaultBalanceLamports}`,
    );
  }
  const floor = p.rentFloorLamports ?? DEFAULT_RENT_FLOOR_LAMPORTS;
  const withFees =
    p.solLamports + (p.solLamports * BUYBACK_FEE_HEADROOM_BPS) / 10_000n;
  if (p.vaultBalanceLamports - withFees < floor) {
    throw new Error(
      `buyback: spend + fee headroom would leave the vault below the rent floor (${floor}) — D-009`,
    );
  }

  const solAmount = new BN(p.solLamports.toString());
  const sdk = new PumpSdk();
  const ixs = await sdk.buyInstructions({
    global: p.global,
    bondingCurveAccountInfo: p.bondingCurveAccountInfo,
    bondingCurve: p.bondingCurve,
    // non-null: the vault ATA exists (pre-created permissionlessly), so the
    // sdk emits no ATA-create instruction inside the proposal.
    associatedUserAccountInfo: p.bondingCurveAccountInfo,
    mint: p.mint,
    user: p.vault,
    amount: getBuyTokenAmountFromSolAmount({
      global: p.global,
      feeConfig: null,
      mintSupply: null,
      bondingCurve: p.bondingCurve,
      amount: solAmount,
      quoteMint: NATIVE_MINT,
    }),
    solAmount,
    slippage: p.slippagePercent ?? 5,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  });
  return ixs;
}

/** Burns TREASURY-held tokens only: the source is the vault's own ATA. */
export function buildBurnIxs(p: BurnParams): TransactionInstruction[] {
  if (p.amount <= 0n) {
    throw new Error("burn: amount must be positive");
  }
  if (p.amount > p.vaultTokenBalance) {
    throw new Error(
      `burn: ${p.amount} exceeds treasury balance ${p.vaultTokenBalance}`,
    );
  }
  const vaultAta = getAssociatedTokenAddressSync(
    p.mint,
    p.vault,
    true,
    p.tokenProgram,
  );
  return [
    createBurnInstruction(vaultAta, p.mint, p.vault, p.amount, [], p.tokenProgram),
  ];
}
