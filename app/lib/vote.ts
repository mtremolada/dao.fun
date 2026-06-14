/**
 * Client-side governance tx builders — thin adapters over the SDK's TESTED
 * resolvers (`@daofun/sdk/governance-tx`), which read the token program from
 * the mint's owner and apply the Token-2022 deposit adaptation (D-013/F-7).
 * pump community mints are Token-2022, so the previous hand-rolled classic
 * path would have FAILED on-chain — these resolvers are proven against the
 * real governance binary (wallet-vote + audit-f7 integration tests). The
 * connected wallet is the only fee-payer/signer.
 */
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { resolveCastVoteTx, resolveDepositTx } from "@daofun/sdk/governance-tx";
import { base64ToBytes } from "./wallet-standard";

function deserialize(txBase64: string): Transaction {
  return Transaction.from(base64ToBytes(txBase64));
}

export async function buildCastVoteTx(
  connection: Connection,
  proposal: PublicKey,
  wallet: PublicKey,
  approve: boolean,
): Promise<Transaction> {
  const { txBase64 } = await resolveCastVoteTx(connection, {
    proposal,
    wallet,
    approve,
  });
  return deserialize(txBase64);
}

export async function buildDepositTx(
  connection: Connection,
  realm: PublicKey,
  governingTokenMint: PublicKey,
  wallet: PublicKey,
  amount: bigint,
): Promise<Transaction> {
  if (amount <= 0n) throw new Error("deposit: amount must be positive");
  const { txBase64 } = await resolveDepositTx(connection, {
    realm,
    governingTokenMint,
    wallet,
    amount,
  });
  return deserialize(txBase64);
}
