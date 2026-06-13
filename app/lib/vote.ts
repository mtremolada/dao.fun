/**
 * Client-side governance transaction builders (no server). The browser
 * reads the proposal/realm context over the user's RPC and assembles the
 * SAME spl-governance instructions the backend used to; the connected
 * wallet then signs AND sends through its own RPC. The wallet is the only
 * fee-payer/signer on every tx built here.
 */
import BN from "bn.js";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Governance,
  Vote,
  VoteChoice,
  VoteKind,
  getGovernanceAccount,
  getProposal,
  getTokenOwnerRecordAddress,
  withCastVote,
  withDepositGoverningTokens,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "./chain";

const PROGRAM_VERSION = 3;

async function finalize(
  ixs: Transaction["instructions"],
  wallet: PublicKey,
  connection: Connection,
): Promise<Transaction> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = wallet;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  return tx;
}

export async function buildCastVoteTx(
  connection: Connection,
  proposal: PublicKey,
  wallet: PublicKey,
  approve: boolean,
): Promise<Transaction> {
  // realm/governance/mint/proposer-record all come from chain state — the
  // caller supplies only (proposal, wallet, approve).
  const prop = await getProposal(connection, proposal);
  const governance = await getGovernanceAccount(
    connection,
    prop.account.governance,
    Governance,
  );
  const realm = governance.account.realm;
  const mint = prop.account.governingTokenMint;
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    mint,
    wallet,
  );
  const vote = approve
    ? new Vote({
        voteType: VoteKind.Approve,
        approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
        deny: undefined,
        veto: undefined,
      })
    : new Vote({
        voteType: VoteKind.Deny,
        approveChoices: undefined,
        deny: true,
        veto: undefined,
      });
  const ixs: Transaction["instructions"] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    prop.account.governance,
    proposal,
    prop.account.tokenOwnerRecord,
    voterTor,
    wallet,
    mint,
    vote,
    wallet,
  );
  return finalize(ixs, wallet, connection);
}

export async function buildDepositTx(
  connection: Connection,
  realm: PublicKey,
  governingTokenMint: PublicKey,
  wallet: PublicKey,
  amount: bigint,
  tokenProgram?: PublicKey,
): Promise<Transaction> {
  if (amount <= 0n) throw new Error("deposit: amount must be positive");
  const source = tokenProgram
    ? getAssociatedTokenAddressSync(governingTokenMint, wallet, false, tokenProgram)
    : getAssociatedTokenAddressSync(governingTokenMint, wallet);
  const ixs: Transaction["instructions"] = [];
  await withDepositGoverningTokens(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    realm,
    source,
    governingTokenMint,
    wallet,
    wallet,
    wallet,
    new BN(amount.toString()),
  );
  return finalize(ixs, wallet, connection);
}
