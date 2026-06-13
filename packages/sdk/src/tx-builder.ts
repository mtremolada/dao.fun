/**
 * Unsigned governance-transaction builders. Originally the backend half of
 * the D-028 browser-signing seam; relocated to the SDK for D-033 so the
 * BROWSER can build, have the wallet sign, and submit these transactions
 * directly against an RPC — no server in the path.
 *
 * Pure builders take every address + the blockhash and are unit-tested
 * against the spl-governance client as an oracle; RpcGovernanceTxSource
 * resolves chain context (blockhash, proposal -> realm/governance/mint)
 * and is exercised by the integration suite. Every built transaction has
 * the WALLET as fee payer and only required signer — there is no way to
 * smuggle a platform key into the signer set.
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
import { SPL_GOVERNANCE_PROGRAM_ID } from "./constants";

const PROGRAM_VERSION = 3;

function toBase64Unsigned(
  ixs: Transaction["instructions"],
  wallet: PublicKey,
  blockhash: string,
): string {
  const tx = new Transaction();
  tx.add(...ixs);
  tx.feePayer = wallet;
  tx.recentBlockhash = blockhash;
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

export interface DepositTxParams {
  realm: PublicKey;
  governingTokenMint: PublicKey;
  wallet: PublicKey;
  amount: bigint;
  blockhash: string;
  /** Token program owning the wallet's source ATA (Token-2022 for v2 mints). */
  tokenProgram?: PublicKey;
}

export async function buildDepositGoverningTokensTx(
  p: DepositTxParams,
): Promise<{ txBase64: string; tokenOwnerRecord: string }> {
  if (p.amount <= 0n) {
    throw new Error("deposit: amount must be positive");
  }
  const source = p.tokenProgram
    ? getAssociatedTokenAddressSync(p.governingTokenMint, p.wallet, false, p.tokenProgram)
    : getAssociatedTokenAddressSync(p.governingTokenMint, p.wallet);
  const ixs: Transaction["instructions"] = [];
  const tokenOwnerRecord = await withDepositGoverningTokens(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    p.realm,
    source,
    p.governingTokenMint,
    p.wallet,
    p.wallet,
    p.wallet,
    new BN(p.amount.toString()),
  );
  return {
    txBase64: toBase64Unsigned(ixs, p.wallet, p.blockhash),
    tokenOwnerRecord: tokenOwnerRecord.toBase58(),
  };
}

export interface CastVoteTxParams {
  realm: PublicKey;
  governance: PublicKey;
  proposal: PublicKey;
  /** The proposer's TokenOwnerRecord (from the proposal account). */
  proposalOwnerRecord: PublicKey;
  governingTokenMint: PublicKey;
  wallet: PublicKey;
  blockhash: string;
  approve: boolean;
}

export async function buildCastVoteTx(
  p: CastVoteTxParams,
): Promise<{ txBase64: string }> {
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    p.realm,
    p.governingTokenMint,
    p.wallet,
  );
  const vote = p.approve
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
    p.realm,
    p.governance,
    p.proposal,
    p.proposalOwnerRecord,
    voterTor,
    p.wallet,
    p.governingTokenMint,
    vote,
    p.wallet,
  );
  return { txBase64: toBase64Unsigned(ixs, p.wallet, p.blockhash) };
}

// ---------- HTTP-facing source (route seam) ----------

export interface GovernanceTxSource {
  depositTx(req: {
    realm: PublicKey;
    governingTokenMint: PublicKey;
    wallet: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  }): Promise<{ txBase64: string; tokenOwnerRecord: string }>;
  castVoteTx(req: {
    proposal: PublicKey;
    wallet: PublicKey;
    approve: boolean;
  }): Promise<{ txBase64: string }>;
  submit(signedTxBase64: string): Promise<{ signature: string }>;
}

export class RpcGovernanceTxSource implements GovernanceTxSource {
  constructor(private readonly connection: Connection) {}

  private async blockhash(): Promise<string> {
    return (await this.connection.getLatestBlockhash("confirmed")).blockhash;
  }

  async depositTx(req: {
    realm: PublicKey;
    governingTokenMint: PublicKey;
    wallet: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  }): Promise<{ txBase64: string; tokenOwnerRecord: string }> {
    return buildDepositGoverningTokensTx({
      ...req,
      blockhash: await this.blockhash(),
    });
  }

  async castVoteTx(req: {
    proposal: PublicKey;
    wallet: PublicKey;
    approve: boolean;
  }): Promise<{ txBase64: string }> {
    // realm/governance/mint/proposer record all come from CHAIN state —
    // the browser supplies only (proposal, wallet, approve).
    const proposal = await getProposal(this.connection, req.proposal);
    const governance = await getGovernanceAccount(
      this.connection,
      proposal.account.governance,
      Governance,
    );
    return buildCastVoteTx({
      realm: governance.account.realm,
      governance: proposal.account.governance,
      proposal: req.proposal,
      proposalOwnerRecord: proposal.account.tokenOwnerRecord,
      governingTokenMint: proposal.account.governingTokenMint,
      wallet: req.wallet,
      blockhash: await this.blockhash(),
      approve: req.approve,
    });
  }

  async submit(signedTxBase64: string): Promise<{ signature: string }> {
    const signature = await this.connection.sendRawTransaction(
      Buffer.from(signedTxBase64, "base64"),
      { skipPreflight: false },
    );
    return { signature };
  }
}
