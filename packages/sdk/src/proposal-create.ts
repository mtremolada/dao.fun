/**
 * Client-side proposal CREATION (the create counterpart to buildExecuteProposalIxs).
 * Browser-safe: a decentralized app builds the create -> insert -> sign-off
 * ceremony itself and the connected wallet signs each group, no server.
 *
 * MVP action: `grant` — a SOL transfer from the DAO's Squads vault to a
 * recipient (spec 6.8), wrapped through the ExecutionAdapter so it executes via
 * the custody chain after the vote + hold-up. The assembly mirrors EXACTLY the
 * `proposeInner` path the bankrun integration suite proves against the real
 * mainnet binaries: read the Squads transactionIndex (+1), set member = native
 * treasury, hold-up = the governance config's minInstructionHoldUpTime,
 * proposalIndex = the governance's proposalCount.
 *
 * Split pure/online like governance-tx.ts: buildCreateGrantProposal is pure
 * (every address + count supplied) so the assembly is proven on real binaries;
 * resolveCreateGrantProposal reads the chain context and calls it.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type Connection,
} from "@solana/web3.js";
import {
  Governance,
  getGovernanceAccount,
  getTokenOwnerRecordAddress,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import { SPL_GOVERNANCE_PROGRAM_ID } from "./constants";
import { deriveGovernanceChainFromMint } from "./pda";
import { buildProposeIxs } from "./proposal";

/** Rent-exempt floor a grant must leave behind in the vault (D-009). */
const DEFAULT_RENT_FLOOR_LAMPORTS = 890_880n;

export interface CreateGrantProposalInputs {
  realm: PublicKey;
  governance: PublicKey;
  /** The DAO's coin mint == the governing-token mint. */
  governingTokenMint: PublicKey;
  /** The Squads multisig's sole member (the governance native treasury). */
  nativeTreasury: PublicKey;
  multisig: PublicKey;
  /** The DAO's Squads vault — the grant source (signs via the custody chain). */
  vault: PublicKey;
  /** The proposer wallet: governance authority + payer for the ceremony. */
  proposer: PublicKey;
  /** The proposer's TokenOwnerRecord (they must hold >= the proposal threshold). */
  tokenOwnerRecord: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  /** Vault SOL balance at build time (bounds the grant; re-checked on execute). */
  vaultBalanceLamports: bigint;
  /** Next proposal index for this governance (== Governance.proposalCount). */
  proposalIndex: number;
  /** Squads multisig.transactionIndex + 1. */
  transactionIndex: bigint;
  /** Per-transaction hold-up (== governance config minInstructionHoldUpTime). */
  holdUpSeconds: number;
  name: string;
}

export interface CreateProposalResult {
  proposal: PublicKey;
  /** descriptionLink / INV-9 artifact hash. */
  innerInstructionSetHash: string;
  /** One per inserted ProposalTransaction (the ExecutionAdapter chain). */
  wrapped: TransactionInstruction[];
  /** Send in order, one wallet-signed transaction each. */
  groups: {
    create: TransactionInstruction[];
    inserts: TransactionInstruction[][];
    signOff: TransactionInstruction[];
  };
}

/** The grant inner instruction with the same bounds as buildGrantIxs (D-009). */
function grantInner(
  vault: PublicKey,
  recipient: PublicKey,
  lamports: bigint,
  vaultBalanceLamports: bigint,
): TransactionInstruction[] {
  if (lamports <= 0n) throw new Error("grant: lamports must be positive");
  if (lamports > vaultBalanceLamports) {
    throw new Error(
      `grant: ${lamports} exceeds vault balance ${vaultBalanceLamports}`,
    );
  }
  if (vaultBalanceLamports - lamports < DEFAULT_RENT_FLOOR_LAMPORTS) {
    throw new Error(
      `grant: would leave the vault below the rent floor (${DEFAULT_RENT_FLOOR_LAMPORTS}) — D-009`,
    );
  }
  return [
    SystemProgram.transfer({
      fromPubkey: vault,
      toPubkey: recipient,
      lamports,
    }),
  ];
}

/** PURE: assemble the create -> insert -> sign-off groups for a grant proposal. */
export async function buildCreateGrantProposal(
  p: CreateGrantProposalInputs,
): Promise<CreateProposalResult> {
  const innerIxs = grantInner(
    p.vault,
    p.recipient,
    p.lamports,
    p.vaultBalanceLamports,
  );
  const made = await buildProposeIxs({
    realm: p.realm,
    governance: p.governance,
    governingTokenMint: p.governingTokenMint,
    tokenOwnerRecord: p.tokenOwnerRecord,
    governanceAuthority: p.proposer,
    payer: p.proposer,
    proposalIndex: p.proposalIndex,
    name: p.name,
    innerIxs,
    wrapCtx: {
      multisigPda: p.multisig,
      vaultIndex: 0,
      transactionIndex: p.transactionIndex,
      member: p.nativeTreasury,
    },
    holdUpSeconds: p.holdUpSeconds,
  });
  return {
    proposal: made.proposal,
    innerInstructionSetHash: made.innerInstructionSetHash,
    wrapped: made.wrapped,
    groups: made.groups,
  };
}

export interface ResolveCreateGrantReq {
  /** The DAO's coin mint. */
  mint: PublicKey;
  /** The connected wallet (must have deposited governing tokens). */
  proposer: PublicKey;
  /** Squads vault (not derivable from the mint — from the DAO's launch result). */
  vault: PublicKey;
  /** Squads multisig (not derivable from the mint). */
  multisig: PublicKey;
  recipient: PublicKey;
  lamports: bigint;
  name: string;
}

/**
 * ONLINE: resolve the full create context from chain (governance proposalCount +
 * hold-up config, the proposer's TokenOwnerRecord, the Squads transactionIndex,
 * the vault balance) and assemble the groups. The browser calls this directly.
 */
export async function resolveCreateGrantProposal(
  connection: Connection,
  req: ResolveCreateGrantReq,
): Promise<CreateProposalResult> {
  const { realm, governance, nativeTreasury } = deriveGovernanceChainFromMint(
    req.mint,
  );
  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    realm,
    req.mint,
    req.proposer,
  );
  const gov = await getGovernanceAccount(connection, governance, Governance);
  const proposalIndex = gov.account.proposalCount;
  const holdUpSeconds = gov.account.config.minInstructionHoldUpTime;

  const msInfo = await connection.getAccountInfo(req.multisig);
  if (!msInfo) throw new Error("multisig account not found on chain");
  const [ms] = multisig.accounts.Multisig.fromAccountInfo(msInfo);
  const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;

  const vaultBalanceLamports = BigInt(await connection.getBalance(req.vault));

  return buildCreateGrantProposal({
    realm,
    governance,
    governingTokenMint: req.mint,
    nativeTreasury,
    multisig: req.multisig,
    vault: req.vault,
    proposer: req.proposer,
    tokenOwnerRecord,
    recipient: req.recipient,
    lamports: req.lamports,
    vaultBalanceLamports,
    proposalIndex,
    transactionIndex,
    holdUpSeconds,
    name: req.name,
  });
}
