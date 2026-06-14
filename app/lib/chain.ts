/**
 * Client-side chain reads (no server). Delegates to the SDK's RpcChainReader
 * so the browser recomputes the INV-9 instruction-set hash, decodes the
 * proposal's real effects, and verifies the DAO's custody structure ITSELF —
 * the same code the integration suite proves against the real mainnet
 * binaries, now running in the user's browser over the user's RPC. This is a
 * trust win: the user verifies, instead of trusting a backend's claim.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import {
  ProposalState,
  getProposalsByGovernance,
} from "@solana/spl-governance";
import {
  RpcChainReader,
  detectProposalAnomalies,
  type ProposalChainState,
  type DaoDashboard,
} from "@daofun/sdk/chain-reader";
import {
  decodeProposalFromChain,
  type ProposalDecode,
  type DecodedInstruction,
} from "@daofun/sdk/decode";
import { verifyDaoByRealm, type DaoVerification } from "@daofun/sdk/verify";
import { deriveGovernanceChainFromMint } from "@daofun/sdk/pda";
import { SPL_GOVERNANCE_PROGRAM_ID } from "@daofun/sdk/constants";
import type { ClaimStatus } from "@daofun/sdk";

// Single source of truth — the deployed governance fork (VERSIONS.md).
export {
  SPL_GOVERNANCE_PROGRAM_ID,
  detectProposalAnomalies,
  type ProposalChainState,
  type DaoDashboard,
  type ProposalDecode,
  type DecodedInstruction,
  type DaoVerification,
  type ClaimStatus,
};

export async function getProposalState(
  connection: Connection,
  proposal: PublicKey,
): Promise<ProposalChainState | null> {
  return new RpcChainReader(connection).getProposalState(proposal);
}

export async function getDashboard(
  connection: Connection,
  realm: PublicKey,
  opts: { vault: PublicKey; wallet?: PublicKey },
): Promise<DaoDashboard | null> {
  return new RpcChainReader(connection).getDashboard(realm, opts);
}

/** Decode a proposal's real effects (INV-10) straight from chain. */
export async function decodeProposal(
  connection: Connection,
  proposal: PublicKey,
): Promise<(ProposalDecode & { partial: boolean }) | null> {
  return decodeProposalFromChain(connection, proposal);
}

/** The buyer's trust primitive: verify custody structure + surface rug risk. */
export async function verifyDao(
  connection: Connection,
  realm: PublicKey,
  opts: { multisigPda?: PublicKey } = {},
): Promise<DaoVerification> {
  return verifyDaoByRealm(connection, realm, opts);
}

// --- Reimbursement/bounty claim lifecycle + per-token DAO discovery ----------
//
// Everything a token's DAO needs is on-chain and re-derivable from the MINT
// alone — no server, no stored index, nothing that can be lost after launch:
// the realm/governance/treasury are deterministic PDAs, and proposals (and
// therefore their votes + bounty reimbursements) are enumerated straight from
// the governance program by getProgramAccounts.

/** Map an on-chain ProposalState to the reimbursement/bounty claim lifecycle. */
export function proposalClaimStatus(state: ProposalState): ClaimStatus {
  switch (state) {
    case ProposalState.Succeeded:
    case ProposalState.Executing:
    case ProposalState.ExecutingWithErrors:
      return "claimable";
    case ProposalState.Completed:
      return "claimed";
    case ProposalState.Defeated:
    case ProposalState.Vetoed:
    case ProposalState.Cancelled:
      return "rejected";
    default: // Draft, SigningOff, Voting
      return "not-ready";
  }
}

export interface DaoAddresses {
  realm: string;
  governance: string;
  nativeTreasury: string;
}

/** The DAO's on-chain addresses, computed offline from the mint (no RPC). */
export function daoFromMint(mint: PublicKey): DaoAddresses {
  const { realm, governance, nativeTreasury } =
    deriveGovernanceChainFromMint(mint);
  return {
    realm: realm.toBase58(),
    governance: governance.toBase58(),
    nativeTreasury: nativeTreasury.toBase58(),
  };
}

export interface ProposalSummary {
  address: string;
  name: string;
  state: string;
  /** Reimbursement/bounty lifecycle: "claimable" once a passing vote carries. */
  claimStatus: ClaimStatus;
  votingCompletedAt: number | null;
}

/**
 * List EVERY proposal of a token's DAO directly from chain (votes + DEX-paid
 * bounty reimbursements included), keyed off the deterministic governance PDA.
 * `enumerate` is injectable so the mapping is unit-testable without an RPC.
 */
export async function listProposals(
  connection: Connection,
  mint: PublicKey,
  opts: { enumerate?: typeof getProposalsByGovernance } = {},
): Promise<ProposalSummary[]> {
  const { governance } = deriveGovernanceChainFromMint(mint);
  const enumerate = opts.enumerate ?? getProposalsByGovernance;
  const proposals = await enumerate(
    connection,
    SPL_GOVERNANCE_PROGRAM_ID,
    governance,
  );
  return proposals
    .map((p) => ({
      address: p.pubkey.toBase58(),
      name: p.account.name,
      state: ProposalState[p.account.state] ?? String(p.account.state),
      claimStatus: proposalClaimStatus(p.account.state),
      votingCompletedAt: p.account.votingCompletedAt
        ? p.account.votingCompletedAt.toNumber()
        : null,
    }))
    .sort((a, b) => (b.votingCompletedAt ?? 0) - (a.votingCompletedAt ?? 0));
}
