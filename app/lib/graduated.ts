/**
 * Post-graduation fee state, read straight from chain.
 *
 * A graduated coin took one of two branches at migration, and which one is
 * visible from whether the `["graduated", mint]` record exists:
 *
 *   BURNED — no record. The LP was destroyed, liquidity is permanent, and
 *            nobody earns anything afterwards. This is devnet's only branch
 *            (Raydium's locker is not deployed there) and it is what the UI
 *            must say, rather than implying a stream that does not exist.
 *
 *   LOCKED — a record. The LP sits with Raydium's locker, equally
 *            unwithdrawable, and the pool's trading fees are collectable
 *            forever by a PDA that can only pay this coin's creator.
 *
 * The one number worth surfacing carefully is the recovery. dao.fun fronts
 * the graduation cost out of the coin's own protocol fees, and the SOL side
 * of collected fees repays that before any split begins — so until it is
 * repaid the creator genuinely sees only the coin side, and calling that
 * "fees earned" would be a lie. Hence `outstanding` and a progress ratio.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { graduatedFeesPda } from "@daofun/sdk/launchpad";
import { launchpadProgramId } from "./cluster";

export interface GraduatedFees {
  /** The Burn & Earn fee key. */
  feeNftMint: PublicKey;
  /** What the protocol fronted for this graduation, in lamports. */
  costLamports: bigint;
  /** Repaid so far out of the SOL side of collected fees. */
  recoveredLamports: bigint;
  /** Still owed; zero once the graduation has paid for itself. */
  outstanding: bigint;
  /** 0..1, for a progress bar. 1 when fully repaid. */
  recoveredRatio: number;
}

/** Layout mirrors the on-chain `GraduatedFees` struct, by byte offset. */
export function decodeGraduatedFees(data: Buffer | Uint8Array): GraduatedFees {
  const d = Buffer.from(data);
  const costLamports = d.readBigUInt64LE(72);
  const recoveredLamports = d.readBigUInt64LE(80);
  const outstanding =
    recoveredLamports >= costLamports ? 0n : costLamports - recoveredLamports;
  return {
    feeNftMint: new PublicKey(d.subarray(40, 72)),
    costLamports,
    recoveredLamports,
    outstanding,
    recoveredRatio:
      costLamports === 0n
        ? 1
        : Math.min(1, Number(recoveredLamports) / Number(costLamports)),
  };
}

/**
 * Null means the coin's liquidity was BURNED, not that something failed —
 * the record only exists on the lock branch. Callers must not render a
 * missing record as an error or as a zeroed fee stream.
 */
export async function fetchGraduatedFees(
  connection: Connection,
  mint: string,
): Promise<GraduatedFees | null> {
  const info = await connection.getAccountInfo(
    graduatedFeesPda(new PublicKey(mint), launchpadProgramId()),
  );
  return info ? decodeGraduatedFees(info.data) : null;
}
