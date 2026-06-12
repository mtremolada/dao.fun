/**
 * Chain reader — spec 6.7 server side. Feeds the proposal view and the
 * dashboard from CHAIN state, not from anything we stored:
 *
 * - The proposal's instruction-set hash is recomputed by re-reading the
 *   ProposalTransaction accounts and unwrapping the Squads plumbing, so
 *   the UI badge compares the artifact against what will actually execute
 *   (INV-9) — the same re-read the GATE 1 mainnet run performed.
 * - The dashboard reports the Squads vault balance, recent vault balance
 *   deltas (sweep history), and the wallet's deposited governing tokens
 *   (== vote weight for no-addin realms, D-013).
 *
 * The RPC implementation is injected behind the ChainReader interface so
 * the HTTP layer and the Playwright e2e suite run against a fake.
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
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
import { SPL_GOVERNANCE_PROGRAM_ID, unwrap, type WrapContext } from "@daofun/sdk";
import { computeInstructionSetHash } from "./artifacts";

export interface ProposalChainState {
  proposal: string;
  name: string;
  /** ProposalState name, e.g. "Voting" | "Succeeded" | "Completed" | "Vetoed". */
  state: string;
  /** Unix seconds; null until voting ends. */
  votingCompletedAt: number | null;
  /** Max hold-up across the proposal's transactions (INV-3 input). */
  holdUpSeconds: number;
  /** Recomputed from on-chain instructions; null when the proposal has none. */
  chainHash: string | null;
  /** descriptionLink, when it is a 64-hex artifact hash (launch convention). */
  publishedArtifactHash: string | null;
  /** Council-mode veto surface (spec 6.7 "veto status"). */
  vetoVoteWeight: string;
  vetoed: boolean;
}

export interface SweepEntry {
  signature: string;
  blockTime: number | null;
  /** Vault balance delta in that transaction (positive = swept in). */
  deltaLamports: number;
}

export interface DaoDashboard {
  realm: string;
  realmName: string;
  vault: string;
  vaultBalanceLamports: number;
  sweeps: SweepEntry[];
  /** Deposited governing tokens for the queried wallet (vote weight, D-013). */
  votePower: { wallet: string; depositedTokens: string } | null;
}

export interface ChainReader {
  getProposalState(proposal: PublicKey): Promise<ProposalChainState | null>;
  getDashboard(
    realm: PublicKey,
    opts: { vault: PublicKey; wallet?: PublicKey | undefined },
  ): Promise<DaoDashboard | null>;
}

// unwrap() never reads its context (the create ix carries everything);
// a placeholder satisfies the signature.
const NULL_CTX: WrapContext = {
  multisigPda: PublicKey.default,
  vaultIndex: 0,
  transactionIndex: 0n,
  member: PublicKey.default,
};

/**
 * INV-9 chain side: hash what actually executes. Squads-wrapped sets are
 * unwrapped to their inner instructions first; a set with no
 * vaultTransactionCreate is hashed as-is.
 */
export function hashWrappedInstructionSet(
  ixs: TransactionInstruction[],
): string | null {
  if (ixs.length === 0) return null;
  let effective = ixs;
  try {
    effective = unwrap(ixs, NULL_CTX);
  } catch {
    // not a wrapped set — hash the raw instructions
  }
  return computeInstructionSetHash(effective);
}

/**
 * Red-flag heuristics over chain-derived proposal state (spec 12.3 —
 * inform, never block outside Guarded; GATE 2 observability). Pure so the
 * UI, the API and any pager share one definition.
 */
export function detectProposalAnomalies(s: ProposalChainState): string[] {
  const anomalies: string[] = [];
  if (s.chainHash === null && s.publishedArtifactHash === null) {
    anomalies.push("no-instructions");
  }
  if (
    s.chainHash !== null &&
    s.publishedArtifactHash !== null &&
    s.chainHash !== s.publishedArtifactHash
  ) {
    anomalies.push("hash-mismatch"); // INV-9 red badge
  }
  if (s.chainHash !== null && s.publishedArtifactHash === null) {
    anomalies.push("missing-artifact-hash"); // INV-10: flagged, never hidden
  }
  if (s.holdUpSeconds === 0) {
    anomalies.push("zero-hold-up"); // sovereign out-of-warranty surface
  }
  return anomalies;
}

/** Vault balance delta from a transaction's pre/post balances. */
export function vaultDelta(
  vault: PublicKey,
  accountKeys: PublicKey[],
  preBalances: number[],
  postBalances: number[],
): number {
  const i = accountKeys.findIndex((k) => k.equals(vault));
  if (i < 0) return 0;
  return (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_PROPOSAL_TXS = 32;
const SWEEP_HISTORY_LIMIT = 10;

export class RpcChainReader implements ChainReader {
  constructor(
    private readonly connection: Connection,
    private readonly programVersion = 3,
    private readonly programId = SPL_GOVERNANCE_PROGRAM_ID,
  ) {}

  async getProposalState(
    proposal: PublicKey,
  ): Promise<ProposalChainState | null> {
    let account;
    try {
      account = (await getProposal(this.connection, proposal)).account;
    } catch {
      return null;
    }

    // Re-read every ProposalTransaction in execution order (option 0 —
    // the only shape the launchpad creates) and recover the inner set.
    const wrapped: TransactionInstruction[] = [];
    let holdUpSeconds = 0;
    for (let index = 0; index < MAX_PROPOSAL_TXS; index++) {
      const addr = await getProposalTransactionAddress(
        this.programId,
        this.programVersion,
        proposal,
        0,
        index,
      );
      let pt;
      try {
        pt = await getGovernanceAccount(this.connection, addr, ProposalTransaction);
      } catch {
        break;
      }
      holdUpSeconds = Math.max(holdUpSeconds, pt.account.holdUpTime);
      for (const data of pt.account.getAllInstructions()) {
        wrapped.push(
          new TransactionInstruction({
            programId: data.programId,
            keys: data.accounts.map((a) => ({
              pubkey: a.pubkey,
              isSigner: a.isSigner,
              isWritable: a.isWritable,
            })),
            data: Buffer.from(data.data),
          }),
        );
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
      chainHash: hashWrappedInstructionSet(wrapped),
      publishedArtifactHash: HEX_64.test(description)
        ? description.toLowerCase()
        : null,
      vetoVoteWeight: account.vetoVoteWeight?.toString() ?? "0",
      vetoed: account.state === ProposalState.Vetoed,
    };
  }

  async getDashboard(
    realm: PublicKey,
    opts: { vault: PublicKey; wallet?: PublicKey | undefined },
  ): Promise<DaoDashboard | null> {
    let realmAccount;
    try {
      realmAccount = (await getRealm(this.connection, realm)).account;
    } catch {
      return null;
    }

    const vaultBalanceLamports = await this.connection.getBalance(opts.vault);

    const sweeps: SweepEntry[] = [];
    const sigs = await this.connection.getSignaturesForAddress(opts.vault, {
      limit: SWEEP_HISTORY_LIMIT,
    });
    for (const sig of sigs) {
      const tx = await this.connection.getTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      });
      if (!tx?.meta) continue;
      sweeps.push({
        signature: sig.signature,
        blockTime: tx.blockTime ?? null,
        // The vault is always a static key in launchpad transactions, so
        // pre/post balance indexes align with staticAccountKeys.
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
        this.programId,
        realm,
        realmAccount.communityMint,
        opts.wallet,
      );
      try {
        const tor = await getGovernanceAccount(
          this.connection,
          torAddr,
          TokenOwnerRecord,
        );
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
}
