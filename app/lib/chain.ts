/**
 * Client-side chain reads (no server). The deployed SPL Governance program
 * on mainnet is the GovER5… fork; we read proposal + realm state directly
 * over the user's RPC with @solana/spl-governance, exactly the accounts the
 * backend reader used — just in the browser now.
 */
import {
  Connection,
  PublicKey,
} from "@solana/web3.js";
import {
  ProposalState,
  ProposalTransaction,
  TokenOwnerRecord,
  getGovernanceAccount,
  getProposal,
  getProposalTransactionAddress,
  getRealm,
  getTokenOwnerRecordAddress,
} from "@solana/spl-governance";

/** Deployed governance program (fork) — pinned (VERSIONS.md / programs/proposal-gate). */
export const SPL_GOVERNANCE_PROGRAM_ID = new PublicKey(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw",
);
const PROGRAM_VERSION = 3;
const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_PROPOSAL_TXS = 32;
const SWEEP_HISTORY_LIMIT = 10;

export interface ProposalChainState {
  proposal: string;
  name: string;
  state: string;
  votingCompletedAt: number | null;
  holdUpSeconds: number;
  /** descriptionLink when it is a 64-hex artifact hash (launch convention). */
  publishedArtifactHash: string | null;
  vetoVoteWeight: string;
  vetoed: boolean;
}

export interface SweepEntry {
  signature: string;
  blockTime: number | null;
  deltaLamports: number;
}

export interface DaoDashboard {
  realm: string;
  realmName: string;
  vault: string;
  vaultBalanceLamports: number;
  sweeps: SweepEntry[];
  votePower: { wallet: string; depositedTokens: string } | null;
}

export async function getProposalState(
  connection: Connection,
  proposal: PublicKey,
): Promise<ProposalChainState | null> {
  let account;
  try {
    account = (await getProposal(connection, proposal)).account;
  } catch {
    return null;
  }

  let holdUpSeconds = 0;
  for (let index = 0; index < MAX_PROPOSAL_TXS; index++) {
    const addr = await getProposalTransactionAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      proposal,
      0,
      index,
    );
    try {
      const pt = await getGovernanceAccount(
        connection,
        addr,
        ProposalTransaction,
      );
      holdUpSeconds = Math.max(holdUpSeconds, pt.account.holdUpTime);
    } catch {
      break;
    }
  }

  const description = account.descriptionLink ?? "";
  return {
    proposal: proposal.toBase58(),
    name: account.name,
    state: ProposalState[account.state] ?? String(account.state),
    votingCompletedAt: account.votingCompletedAt
      ? account.votingCompletedAt.toNumber()
      : null,
    holdUpSeconds,
    publishedArtifactHash: HEX_64.test(description)
      ? description.toLowerCase()
      : null,
    vetoVoteWeight: account.vetoVoteWeight?.toString() ?? "0",
    vetoed: account.state === ProposalState.Vetoed,
  };
}

function vaultDelta(
  vault: PublicKey,
  accountKeys: PublicKey[],
  pre: number[],
  post: number[],
): number {
  const i = accountKeys.findIndex((k) => k.equals(vault));
  if (i < 0) return 0;
  return (post[i] ?? 0) - (pre[i] ?? 0);
}

export async function getDashboard(
  connection: Connection,
  realm: PublicKey,
  opts: { vault: PublicKey; wallet?: PublicKey },
): Promise<DaoDashboard | null> {
  let realmAccount;
  try {
    realmAccount = (await getRealm(connection, realm)).account;
  } catch {
    return null;
  }

  const vaultBalanceLamports = await connection.getBalance(opts.vault);

  const sweeps: SweepEntry[] = [];
  const sigs = await connection.getSignaturesForAddress(opts.vault, {
    limit: SWEEP_HISTORY_LIMIT,
  });
  for (const sig of sigs) {
    const tx = await connection.getTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) continue;
    sweeps.push({
      signature: sig.signature,
      blockTime: tx.blockTime ?? null,
      deltaLamports: vaultDelta(
        opts.vault,
        tx.transaction.message.staticAccountKeys,
        tx.meta.preBalances,
        tx.meta.postBalances,
      ),
    });
  }

  let votePower: DaoDashboard["votePower"] = null;
  if (opts.wallet) {
    const torAddr = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      realm,
      realmAccount.communityMint,
      opts.wallet,
    );
    try {
      const tor = await getGovernanceAccount(connection, torAddr, TokenOwnerRecord);
      votePower = {
        wallet: opts.wallet.toBase58(),
        depositedTokens: tor.account.governingTokenDepositAmount.toString(),
      };
    } catch {
      votePower = { wallet: opts.wallet.toBase58(), depositedTokens: "0" };
    }
  }

  return {
    realm: realm.toBase58(),
    realmName: realmAccount.name,
    vault: opts.vault.toBase58(),
    vaultBalanceLamports,
    sweeps,
    votePower,
  };
}
