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
import { createHash } from "node:crypto";
import {
  Connection,
  PublicKey,
  SystemProgram,
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

  const execute = buildExecuteIx(
    decodeVaultMessage(create),
    ctx,
    vaultPda,
    transactionPda,
  );

  return [create, proposalCreate, approve, execute];
}

// Squads v4 TransactionBuffer PDA:
// ["multisig", multisig, "transaction_buffer", creator, buffer_index (u8)].
function getTransactionBufferPda(
  multisigPda: PublicKey,
  creator: PublicKey,
  bufferIndex: number,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("multisig"),
      multisigPda.toBuffer(),
      Buffer.from("transaction_buffer"),
      creator.toBuffer(),
      Buffer.from([bufferIndex]),
    ],
    SQUADS_V4_PROGRAM_ID,
  )[0];
}

export interface WrapBufferedResult {
  /**
   * bufferCreate, extend×n, vaultTransactionCreateFromBuffer,
   * proposalCreate, approve, execute — one governance ProposalTransaction
   * each, executed in order.
   */
  ixs: TransactionInstruction[];
  extendCount: number;
}

/**
 * Buffered variant of wrap() for account-heavy inner sets: the plain
 * VaultTransactionCreate carries the whole serialized vault message, which
 * overflows the 1232-byte budget of the governance InsertTransaction that
 * has to carry it (~19-account instructions already exceed it — found by
 * GATE 0c). Here the message is staged on-chain in chunks through Squads
 * transaction buffers, then the vault transaction is created FROM the
 * buffer; the buffer is hash-pinned (sha256 + final size) at creation, so
 * chunking does not weaken INV-9.
 */
export function wrapBuffered(
  innerIxs: TransactionInstruction[],
  ctx: WrapContext,
  chunkSize = 400,
  bufferIndex = 0,
): WrapBufferedResult {
  if (innerIxs.length === 0) {
    throw new Error("wrapBuffered: inner instruction set is empty");
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
  const bufferPda = getTransactionBufferPda(
    ctx.multisigPda,
    ctx.member,
    bufferIndex,
  );

  const messageBytes = Buffer.from(
    multisig.utils.transactionMessageToMultisigTransactionMessageBytes({
      message: new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: PLACEHOLDER_BLOCKHASH,
        instructions: innerIxs,
      }),
      vaultPda,
    }),
  );
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < messageBytes.length; offset += chunkSize) {
    chunks.push(messageBytes.subarray(offset, offset + chunkSize));
  }

  const bufferCreate = multisig.generated.createTransactionBufferCreateInstruction(
    {
      multisig: ctx.multisigPda,
      transactionBuffer: bufferPda,
      creator: ctx.member,
      rentPayer: ctx.member,
    },
    {
      args: {
        bufferIndex,
        vaultIndex: ctx.vaultIndex,
        finalBufferHash: Array.from(
          createHash("sha256").update(messageBytes).digest(),
        ),
        finalBufferSize: messageBytes.length,
        buffer: chunks[0]!,
      },
    },
    SQUADS_V4_PROGRAM_ID,
  );
  const extendIxs = chunks.slice(1).map((chunk) =>
    multisig.generated.createTransactionBufferExtendInstruction(
      {
        multisig: ctx.multisigPda,
        transactionBuffer: bufferPda,
        creator: ctx.member,
      },
      { args: { buffer: chunk } },
      SQUADS_V4_PROGRAM_ID,
    ),
  );
  const createFromBuffer =
    multisig.generated.createVaultTransactionCreateFromBufferInstruction(
      {
        vaultTransactionCreateItemMultisig: ctx.multisigPda,
        vaultTransactionCreateItemTransaction: transactionPda,
        vaultTransactionCreateItemCreator: ctx.member,
        vaultTransactionCreateItemRentPayer: ctx.member,
        vaultTransactionCreateItemSystemProgram: SystemProgram.programId,
        transactionBuffer: bufferPda,
        creator: ctx.member,
      },
      {
        args: {
          vaultIndex: ctx.vaultIndex,
          ephemeralSigners: 0,
          // the real message comes from the buffer account; the program
          // REQUIRES this exact six-zero-byte placeholder
          // (vault_transaction_create_from_buffer.rs: InvalidInstructionArgs
          // otherwise).
          transactionMessage: new Uint8Array([0, 0, 0, 0, 0, 0]),
          memo: null,
        },
      },
      SQUADS_V4_PROGRAM_ID,
    );

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
  const execute = buildExecuteIx(
    deserializeVaultMessage(messageBytes),
    ctx,
    vaultPda,
    transactionPda,
  );

  return {
    ixs: [bufferCreate, ...extendIxs, createFromBuffer, proposalCreate, approve, execute],
    extendCount: extendIxs.length,
  };
}

type DecodedVaultMessage = Parameters<typeof multisig.utils.isSignerIndex>[0];

function deserializeVaultMessage(messageBytes: Buffer): DecodedVaultMessage {
  const [message] = multisig.types.transactionMessageBeet.deserialize(messageBytes);
  // The beet wire type and the generated account type are structurally
  // identical for the fields the index helpers read (numSigners,
  // numWritable*, accountKeys, instructions); only the array element types
  // differ nominally (number[] vs Uint8Array).
  return message as unknown as DecodedVaultMessage;
}

function decodeVaultMessage(create: TransactionInstruction): DecodedVaultMessage {
  const [decoded] = multisig.generated.vaultTransactionCreateStruct.deserialize(
    create.data,
  );
  return deserializeVaultMessage(
    Buffer.from(decoded.args.transactionMessage as Uint8Array),
  );
}

function buildExecuteIx(
  message: DecodedVaultMessage,
  ctx: WrapContext,
  vaultPda: PublicKey,
  transactionPda: PublicKey,
): TransactionInstruction {
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

function messageToInstructions(
  message: DecodedVaultMessage,
): TransactionInstruction[] {
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

function hasDiscriminator(ix: TransactionInstruction, disc: number[]): boolean {
  return (
    ix.programId.equals(SQUADS_V4_PROGRAM_ID) &&
    ix.data.subarray(0, 8).equals(Buffer.from(disc))
  );
}

/**
 * Recover the inner instructions from a wrapped set (decoder seam).
 * Handles both wrap() (plain VaultTransactionCreate) and wrapBuffered()
 * (the vault message reassembled from the buffer chunks). Instructions
 * AFTER the vaultTransactionExecute step are direct treasury-signed legs
 * (D-022) and are appended to the recovered inner set as-is, so the
 * INV-9 hash covers them.
 */
export function unwrap(
  wrappedIxs: TransactionInstruction[],
  _ctx: WrapContext,
): TransactionInstruction[] {
  const execIdx = wrappedIxs.findIndex((ix) =>
    hasDiscriminator(
      ix,
      multisig.generated.vaultTransactionExecuteInstructionDiscriminator,
    ),
  );
  const chainIxs = execIdx >= 0 ? wrappedIxs.slice(0, execIdx + 1) : wrappedIxs;
  const directIxs = execIdx >= 0 ? wrappedIxs.slice(execIdx + 1) : [];

  const create = chainIxs.find((ix) =>
    hasDiscriminator(
      ix,
      multisig.generated.vaultTransactionCreateInstructionDiscriminator,
    ),
  );
  if (create) {
    return [...messageToInstructions(decodeVaultMessage(create)), ...directIxs];
  }

  // Buffered chain: reassemble the message from bufferCreate + extends.
  const bufferCreate = chainIxs.find((ix) =>
    hasDiscriminator(
      ix,
      multisig.generated.transactionBufferCreateInstructionDiscriminator,
    ),
  );
  if (!bufferCreate) {
    throw new Error(
      "unwrap: no vaultTransactionCreate or transactionBufferCreate instruction found",
    );
  }
  const [decoded] = multisig.generated.transactionBufferCreateStruct.deserialize(
    bufferCreate.data,
  );
  const chunks = [Buffer.from(decoded.args.buffer as Uint8Array)];
  for (const ix of chainIxs) {
    if (
      hasDiscriminator(
        ix,
        multisig.generated.transactionBufferExtendInstructionDiscriminator,
      )
    ) {
      const [ext] = multisig.generated.transactionBufferExtendStruct.deserialize(
        ix.data,
      );
      chunks.push(Buffer.from(ext.args.buffer as Uint8Array));
    }
  }
  const messageBytes = Buffer.concat(chunks);
  if (messageBytes.length !== decoded.args.finalBufferSize) {
    throw new Error(
      `unwrap: buffered message incomplete (${messageBytes.length} of ${decoded.args.finalBufferSize} bytes)`,
    );
  }
  if (
    !createHash("sha256")
      .update(messageBytes)
      .digest()
      .equals(Buffer.from(decoded.args.finalBufferHash))
  ) {
    throw new Error("unwrap: buffered message hash mismatch");
  }
  return [
    ...messageToInstructions(deserializeVaultMessage(messageBytes)),
    ...directIxs,
  ];
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
