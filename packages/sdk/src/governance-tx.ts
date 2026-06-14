/**
 * Governance transaction builders (D-028) — pure + online, browser-safe.
 *
 * Lives in the SDK (not the backend) so the BROWSER can build deposit/vote
 * transactions itself, with no server in the path: a decentralized app signs
 * and submits directly against an RPC. The backend re-exports these and its
 * RpcGovernanceTxSource delegates here, so the server seam is unchanged.
 *
 * Pure builders take every address + a blockhash; the online resolvers take a
 * Connection and fetch the chain context (token program from the mint owner;
 * realm/governance/mint/proposer-record from the proposal). Every built tx has
 * the WALLET as fee payer and only required signer — no platform key can enter
 * the signer set.
 */
import BN from "bn.js";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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

/**
 * Deployed spl-governance v3.1.4 needs Token-2022 governing-token deposits to
 * (a) carry the Token-2022 program — the 0.3.28 JS client hardcodes the classic
 * Token program on the transfer — and (b) append the mint account ("Expected
 * mint account is required for Token-2022 deposits and withdrawals"). Pump
 * `create_v2` mints are ALWAYS Token-2022 (D-004), so without both adaptations a
 * browser-built deposit reverts on chain and the holder receives NO vote weight
 * (AUDIT F-7). Mirrors the patch proven on mainnet by mainnet-gate1-sovereign.ts.
 */
function adaptDepositForToken2022(
  ixs: TransactionInstruction[],
  mint: PublicKey,
): TransactionInstruction[] {
  const retargeted = ixs.map(
    (ix) =>
      new TransactionInstruction({
        programId: ix.programId,
        data: ix.data,
        keys: ix.keys.map((k) =>
          k.pubkey.equals(TOKEN_PROGRAM_ID)
            ? { ...k, pubkey: TOKEN_2022_PROGRAM_ID }
            : k,
        ),
      }),
  );
  const last = retargeted[retargeted.length - 1]!;
  retargeted[retargeted.length - 1] = new TransactionInstruction({
    programId: last.programId,
    data: last.data,
    keys: [...last.keys, { pubkey: mint, isSigner: false, isWritable: false }],
  });
  return retargeted;
}

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
    ? getAssociatedTokenAddressSync(
        p.governingTokenMint,
        p.wallet,
        false,
        p.tokenProgram,
      )
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
  const finalIxs =
    p.tokenProgram && p.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? adaptDepositForToken2022(ixs, p.governingTokenMint)
      : ixs;
  return {
    txBase64: toBase64Unsigned(finalIxs, p.wallet, p.blockhash),
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

// ---------- Online resolvers (take a Connection; browser or server) ----------

/**
 * Resolve a deposit tx fully from chain: the token program is read from the
 * mint's OWNER (so a Token-2022 mint always gets the F-7 adaptation, and a
 * caller cannot supply a wrong/missing program), and a fresh blockhash is
 * fetched. The browser calls this directly — no backend needed.
 */
export async function resolveDepositTx(
  connection: Connection,
  req: {
    realm: PublicKey;
    governingTokenMint: PublicKey;
    wallet: PublicKey;
    amount: bigint;
    tokenProgram?: PublicKey;
  },
): Promise<{ txBase64: string; tokenOwnerRecord: string }> {
  let tokenProgram = req.tokenProgram;
  try {
    const info = await connection.getAccountInfo(req.governingTokenMint);
    if (info) tokenProgram = info.owner;
  } catch {
    // fall back to the caller-supplied hint (or classic default)
  }
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  return buildDepositGoverningTokensTx({
    ...req,
    ...(tokenProgram ? { tokenProgram } : {}),
    blockhash,
  });
}

/**
 * Resolve a cast-vote tx from the proposal account alone: realm, governance,
 * mint, and the proposer's record all come from CHAIN state; the caller
 * supplies only (proposal, wallet, approve).
 */
export async function resolveCastVoteTx(
  connection: Connection,
  req: { proposal: PublicKey; wallet: PublicKey; approve: boolean },
): Promise<{ txBase64: string }> {
  const proposal = await getProposal(connection, req.proposal);
  const governance = await getGovernanceAccount(
    connection,
    proposal.account.governance,
    Governance,
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  return buildCastVoteTx({
    realm: governance.account.realm,
    governance: proposal.account.governance,
    proposal: req.proposal,
    proposalOwnerRecord: proposal.account.tokenOwnerRecord,
    governingTokenMint: proposal.account.governingTokenMint,
    wallet: req.wallet,
    blockhash,
    approve: req.approve,
  });
}
