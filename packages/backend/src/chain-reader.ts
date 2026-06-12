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
  /**
   * SOONEST any instruction can execute: the MIN hold-up across the
   * proposal's transactions (INV-3). Min, not max — a single short-hold-up
   * leg defines when the proposal can first act, so reporting the max would
   * mask a fast/zero-hold-up drain hidden among slow legs.
   */
  holdUpSeconds: number;
  /** Recomputed from on-chain instructions; null when the proposal has none. */
  chainHash: string | null;
  /** descriptionLink, when it is a 64-hex artifact hash (launch convention). */
  publishedArtifactHash: string | null;
  /**
   * False when the on-chain instruction set could NOT be fully re-read (more
   * transactions than the read ceiling, or a hole within the claimed count).
   * A partial read makes `chainHash` cover only a PREFIX of what executes, so
   * a green badge would be a lie — callers must treat this as an INV-9 red flag.
   */
  instructionSetComplete: boolean;
  /**
   * False when the proposal is not the launchpad's canonical single-option
   * ("Approve") shape. The reader only recomputes option 0; transactions under
   * other options would execute unseen, so a non-canonical shape is itself an
   * anomaly the launchpad never produces (AUDIT F-8).
   */
  singleOption: boolean;
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
  // AUDIT F-8: a partial recompute means the green hash badge would only
  // cover a PREFIX of the executed set — never let that read as "verified".
  if (!s.instructionSetComplete) {
    anomalies.push("incomplete-instruction-set"); // INV-9 red flag
  }
  // AUDIT F-8: the launchpad only ever creates single-option proposals;
  // anything else can hide executing transactions under an unread option.
  if (!s.singleOption) {
    anomalies.push("unexpected-proposal-shape"); // INV-10 red flag
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
/**
 * Read ceiling for a proposal's ProposalTransactions. This is a DoS bound on
 * RPC calls, NOT a correctness bound: if a proposal claims more transactions
 * than this, the recompute is marked INCOMPLETE (a red flag) rather than
 * silently truncated. Honest launchpad proposals use well under a dozen; the
 * ceiling is generous so completeness is governed by the on-chain count, not
 * an arbitrary cutoff (AUDIT F-8).
 */
export const MAX_PROPOSAL_TXS = 128;
const SWEEP_HISTORY_LIMIT = 10;

export interface ProposalTxData {
  holdUpTime: number;
  instructions: TransactionInstruction[];
}

export interface CollectedProposalTxs {
  /** All instructions across the read transactions, in execution order. */
  wrapped: TransactionInstruction[];
  /** MIN hold-up across read transactions (soonest execution); 0 if none. */
  minHoldUpSeconds: number;
  /**
   * True iff exactly `expectedCount` transactions were read with no holes and
   * the count did not exceed the read ceiling. False means `wrapped` is a
   * PREFIX (or has gaps) and any hash over it is untrustworthy (INV-9).
   */
  complete: boolean;
}

/**
 * Re-read a proposal's transaction set by AUTHORITATIVE count (the proposal
 * option's `instructionsNextIndex`), never by a fixed cap or a break-on-first-
 * gap loop. This is the heart of the INV-9 chain-side recompute: it must cover
 * EVERYTHING that will execute, or report that it could not (AUDIT F-8).
 *
 * Pure (RPC injected via `fetchTx`) so the truncation/hole/over-cap behaviour
 * is unit-tested without a network.
 */
export async function collectProposalTransactions(
  expectedCount: number,
  fetchTx: (index: number) => Promise<ProposalTxData | null>,
  readCap: number = MAX_PROPOSAL_TXS,
): Promise<CollectedProposalTxs> {
  const wrapped: TransactionInstruction[] = [];
  let minHoldUp: number | null = null;
  let complete = true;
  const claimed = Math.max(Math.floor(expectedCount), 0);
  // Over the ceiling: read what we can but never report it as complete.
  if (claimed > readCap) complete = false;
  const toRead = Math.min(claimed, readCap);
  for (let index = 0; index < toRead; index++) {
    const tx = await fetchTx(index);
    if (!tx) {
      // A hole inside the claimed range (e.g. a removed transaction): the
      // recompute can no longer represent the executed set faithfully.
      complete = false;
      continue;
    }
    minHoldUp =
      minHoldUp === null ? tx.holdUpTime : Math.min(minHoldUp, tx.holdUpTime);
    wrapped.push(...tx.instructions);
  }
  return { wrapped, minHoldUpSeconds: minHoldUp ?? 0, complete };
}

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

    // Recompute INV-9 from the AUTHORITATIVE on-chain transaction count
    // (option 0's instructionsNextIndex), not a fixed cap or a break-on-gap
    // scan — otherwise a proposal with >cap transactions, or under a second
    // option, would let a hidden leg execute outside the recomputed hash
    // while a crafted descriptionLink still shows green (AUDIT F-8). Only the
    // launchpad's canonical single-option shape is fully representable here;
    // anything else is surfaced as an anomaly.
    const singleOption = account.options.length === 1;
    const expectedCount =
      account.options[0]?.instructionsNextIndex ??
      account.instructionsNextIndex ??
      0;
    const { wrapped, minHoldUpSeconds, complete } =
      await collectProposalTransactions(expectedCount, async (index) => {
        const addr = await getProposalTransactionAddress(
          this.programId,
          this.programVersion,
          proposal,
          0,
          index,
        );
        let pt;
        try {
          pt = await getGovernanceAccount(
            this.connection,
            addr,
            ProposalTransaction,
          );
        } catch {
          return null;
        }
        return {
          holdUpTime: pt.account.holdUpTime,
          instructions: pt.account.getAllInstructions().map(
            (data) =>
              new TransactionInstruction({
                programId: data.programId,
                keys: data.accounts.map((a) => ({
                  pubkey: a.pubkey,
                  isSigner: a.isSigner,
                  isWritable: a.isWritable,
                })),
                data: Buffer.from(data.data),
              }),
          ),
        };
      });

    const description = account.descriptionLink ?? "";
    return {
      proposal: proposal.toBase58(),
      name: account.name,
      state: ProposalState[account.state] ?? String(account.state),
      votingCompletedAt: account.votingCompletedAt
        ? account.votingCompletedAt.toNumber()
        : null,
      holdUpSeconds: minHoldUpSeconds,
      // AUDIT F-8 (fail-safe): if the executed set could not be fully re-read,
      // a hash over the partial set is untrustworthy — refuse to publish one at
      // all, so NO surface (the `hashBadge` "verified" state included) can ever
      // render green over a prefix. The `incomplete-instruction-set` anomaly
      // carries the reason.
      chainHash: complete ? hashWrappedInstructionSet(wrapped) : null,
      publishedArtifactHash: HEX_64.test(description)
        ? description.toLowerCase()
        : null,
      instructionSetComplete: complete,
      singleOption,
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
