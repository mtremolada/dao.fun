/**
 * Shared browser submit primitive: build a tx from instructions, co-sign with
 * any ephemeral keypairs, have the wallet sign, submit to the RPC, confirm.
 * Used by the permissionless collect-fees button and other one-shot actions.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { SignerLike } from "./governance-actions";
import { base64ToBytes, bytesToBase64 } from "./wallet-standard";

export async function signSubmitInstructions(
  connection: Connection,
  instructions: TransactionInstruction[],
  signer: SignerLike,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...instructions);
  tx.feePayer = new PublicKey(signer.address);
  tx.recentBlockhash = blockhash;
  if (extraSigners.length > 0) tx.partialSign(...extraSigners);
  const unsigned = bytesToBase64(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  const signed = await signer.signTransaction(unsigned);
  const sig = await connection.sendRawTransaction(base64ToBytes(signed), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}
