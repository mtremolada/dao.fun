/**
 * Permissionless fee collection ("Collect fees → vault"), client-side. pump's
 * collect_creator_fee_v2 has ZERO signer accounts (D-006/INV-2): the creator
 * (the DAO's Squads vault PDA) never signs, the clicker only pays the tx fee,
 * and the destination is fixed by pump to the vault. So anyone can sweep a
 * DAO's accrued creator fees into its treasury — no authority, no server.
 */
import {
  Connection,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { PumpFunRail } from "@daofun/sdk/rails/pumpfun";
import type { WalletSender } from "./wallet-sender";

/**
 * Build + sign + send the collect for `vault` (the pump creator). Returns the
 * tx signature. `feePayer` (the connected wallet) is the only signer; it also
 * pays for the post-graduation AMM->curve consolidation leg when present.
 */
export async function collectFees(
  connection: Connection,
  sender: WalletSender,
  vault: PublicKey,
): Promise<string> {
  const wallet = new PublicKey(sender.address);
  const rail = new PumpFunRail(connection);
  const ixs = await rail.buildCollectFeesIxs(vault, wallet);
  if (ixs.length === 0) throw new Error("no fees to collect");
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  const sig = await sender.signAndSend(tx, connection);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
