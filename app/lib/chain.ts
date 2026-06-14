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

// Single source of truth — the deployed governance fork (VERSIONS.md).
export { SPL_GOVERNANCE_PROGRAM_ID } from "@daofun/sdk/constants";

export {
  detectProposalAnomalies,
  type ProposalChainState,
  type DaoDashboard,
  type ProposalDecode,
  type DecodedInstruction,
  type DaoVerification,
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
