/**
 * ExecutionAdapter — spec 6.4, the custody seam.
 *
 * `wrap(innerIxs)` produces the ordered instruction set that, when executed
 * by SPL Governance (the native-treasury PDA "signs" via invoke_signed,
 * being the Squads multisig's sole member), drives the Squads chain:
 *
 *   1. vaultTransactionCreate   (innerIxs compiled into the vault message)
 *   2. proposalCreate           (Squads-internal proposal)
 *   3. proposalApprove          (threshold is 1; one member approval)
 *   4. vaultTransactionExecute  (vault PDA invoke_signs the inner ixs)
 *
 * Each step is intended to be inserted as its OWN SPL-Governance
 * ProposalTransaction, executed in order — that is the CU-isolation split.
 * Finer splitting of oversized inner sets is calibrated by the Stage 1
 * integration CU suite.
 *
 * `unwrap` recovers the inner instructions from the wrapped set so the
 * decode/simulate harness (spec 12.3) shows voters the REAL effects, not
 * the Squads plumbing (INV-10), and the instruction-set hash covers what
 * actually executes (INV-9).
 *
 * Offline by design: no address-lookup-table support in MVP wrapping, which
 * keeps account resolution synchronous (Squads' accountsForTransactionExecute
 * only consults the network for ALTs).
 */
import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import { SQUADS_V4_PROGRAM_ID } from "./constants";

export interface WrapContext {
  multisigPda: PublicKey;
  vaultIndex: number;
  /** Squads transaction index: on-chain multisig.transactionIndex + 1 at execution time. */
  transactionIndex: bigint;
  /** The realm's native-treasury PDA — the multisig's sole member (INV-7). */
  member: PublicKey;
}

// The vault message format carries no blockhash; web3.js just requires a
// well-formed one to compile a TransactionMessage.
const PLACEHOLDER_BLOCKHASH = "11111111111111111111111111111111";

export function wrap(
  innerIxs: TransactionInstruction[],
  ctx: WrapContext,
): TransactionInstruction[] {
  if (innerIxs.length === 0) {
    throw new Error("wrap: inner instruction set is empty");
  }
  const [vaultPda] = multisig.getVaultPda({
    multisigPda: ctx.multisigPda,
    index: ctx.vaultIndex,
    programId: SQUADS_V4_PROGRAM_ID,
  });
  const [transactionPda] = multisig.getTransactionPda({
    multisigPda: ctx.multisigPda,
    index: ctx.transactionIndex,
    programId: SQUADS_V4_PROGRAM_ID,
  });

  const vaultMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions: innerIxs,
  });

  const create = multisig.instructions.vaultTransactionCreate({
    multisigPda: ctx.multisigPda,
    transactionIndex: ctx.transactionIndex,
    creator: ctx.member,
    rentPayer: ctx.member, // native treasury pays rent (keep it SOL-funded)
    vaultIndex: ctx.vaultIndex,
    ephemeralSigners: 0,
    transactionMessage: vaultMessage,
    programId: SQUADS_V4_PROGRAM_ID,
  });

  const proposalCreate = multisig.instructions.proposalCreate({
    multisigPda: ctx.multisigPda,
    creator: ctx.member,
    transactionIndex: ctx.transactionIndex,
    programId: SQUADS_V4_PROGRAM_ID,
  });

  const approve = multisig.instructions.proposalApprove({
    multisigPda: ctx.multisigPda,
    transactionIndex: ctx.transactionIndex,
    member: ctx.member,
    programId: SQUADS_V4_PROGRAM_ID,
  });

  const execute = buildExecuteIx(create, ctx, vaultPda, transactionPda);

  return [create, proposalCreate, approve, execute];
}

function decodeVaultMessage(create: TransactionInstruction) {
  const [decoded] = multisig.generated.vaultTransactionCreateStruct.deserialize(
    create.data,
  );
  const messageBytes = Buffer.from(decoded.args.transactionMessage as Uint8Array);
  const [message] = multisig.types.transactionMessageBeet.deserialize(messageBytes);
  // The beet wire type and the generated account type are structurally
  // identical for the fields the index helpers read (numSigners,
  // numWritable*, accountKeys, instructions); only the array element types
  // differ nominally (number[] vs Uint8Array).
  return message as unknown as Parameters<
    typeof multisig.utils.isSignerIndex
  >[0];
}

function buildExecuteIx(
  create: TransactionInstruction,
  ctx: WrapContext,
  vaultPda: PublicKey,
  transactionPda: PublicKey,
): TransactionInstruction {
  const message = decodeVaultMessage(create);
  const [proposalPda] = multisig.getProposalPda({
    multisigPda: ctx.multisigPda,
    transactionIndex: ctx.transactionIndex,
    programId: SQUADS_V4_PROGRAM_ID,
  });

  // No ALTs in MVP wrapping -> the connection is provably never used by
  // accountsForTransactionExecute; resolution is fully offline.
  if (message.addressTableLookups.length > 0) {
    throw new Error("wrap: address lookup tables are not supported in MVP");
  }
  const accountMetas: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] =
    [];
  for (const [accountIndex, accountKey] of message.accountKeys.entries()) {
    accountMetas.push({
      pubkey: accountKey,
      isWritable: multisig.utils.isStaticWritableIndex(message, accountIndex),
      // The vault PDA invoke_signs inside the program; it must not be marked
      // as a transaction-level signer.
      isSigner:
        multisig.utils.isSignerIndex(message, accountIndex) &&
        !accountKey.equals(vaultPda),
    });
  }

  return multisig.generated.createVaultTransactionExecuteInstruction(
    {
      multisig: ctx.multisigPda,
      proposal: proposalPda,
      transaction: transactionPda,
      member: ctx.member,
      anchorRemainingAccounts: accountMetas,
    },
    SQUADS_V4_PROGRAM_ID,
  );
}

/** Recover the inner instructions from a wrapped set (decoder seam). */
export function unwrap(
  wrappedIxs: TransactionInstruction[],
  _ctx: WrapContext,
): TransactionInstruction[] {
  const createDisc = Buffer.from(
    multisig.generated.vaultTransactionCreateInstructionDiscriminator,
  );
  const create = wrappedIxs.find(
    (ix) =>
      ix.programId.equals(SQUADS_V4_PROGRAM_ID) &&
      ix.data.subarray(0, 8).equals(createDisc),
  );
  if (!create) {
    throw new Error("unwrap: no vaultTransactionCreate instruction found");
  }
  const message = decodeVaultMessage(create);

  return message.instructions.map(
    (compiled) =>
      new TransactionInstruction({
        programId: message.accountKeys[compiled.programIdIndex]!,
        keys: Array.from(compiled.accountIndexes).map((accountIndex) => ({
          pubkey: message.accountKeys[accountIndex]!,
          isSigner: multisig.utils.isSignerIndex(message, accountIndex),
          isWritable: multisig.utils.isStaticWritableIndex(message, accountIndex),
        })),
        data: Buffer.from(compiled.data),
      }),
  );
}

/**
 * Fetch the next Squads transaction index for a multisig (wrap-time helper
 * for the orchestrator).
 */
export async function fetchNextTransactionIndex(
  connection: Connection,
  multisigPda: PublicKey,
): Promise<bigint> {
  const ms = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  return BigInt(ms.transactionIndex.toString()) + 1n;
}
