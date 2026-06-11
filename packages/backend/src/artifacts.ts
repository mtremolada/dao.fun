/**
 * Simulation/decode artifact store — spec 12.3.
 *
 * Artifacts are off-chain, keyed by (proposal, instruction-set hash). The
 * hash is computed over the canonical serialization of the instruction set
 * in EXECUTION ORDER, covering program ids, account keys with their
 * signer/writable flags, and instruction data — so any tamper or reorder
 * breaks the key and the UI badge turns red (INV-9/10).
 */
import { createHash } from "node:crypto";
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export function computeInstructionSetHash(
  ixs: TransactionInstruction[],
): string {
  const h = createHash("sha256");
  for (const ix of ixs) {
    h.update(ix.programId.toBuffer());
    h.update(Buffer.from([ix.keys.length]));
    for (const meta of ix.keys) {
      h.update(meta.pubkey.toBuffer());
      h.update(Buffer.from([meta.isSigner ? 1 : 0, meta.isWritable ? 1 : 0]));
    }
    const len = Buffer.alloc(4);
    len.writeUInt32LE(ix.data.length);
    h.update(len);
    h.update(ix.data);
  }
  return h.digest("hex");
}

export interface ProposalArtifact {
  decodedSummary: string;
  simulation: unknown;
  redFlags: string[];
}

export interface ArtifactStore {
  put(
    proposal: PublicKey,
    instructionSetHash: string,
    artifact: ProposalArtifact,
  ): Promise<void>;
  get(
    proposal: PublicKey,
    instructionSetHash: string,
  ): Promise<ProposalArtifact | null>;
}

/** In-memory store for tests/dev; the sqlite ARTIFACT_STORE lands with the API. */
export class MemoryArtifactStore implements ArtifactStore {
  private artifacts = new Map<string, ProposalArtifact>();

  private key(proposal: PublicKey, hash: string): string {
    return `${proposal.toBase58()}:${hash}`;
  }

  async put(
    proposal: PublicKey,
    instructionSetHash: string,
    artifact: ProposalArtifact,
  ): Promise<void> {
    this.artifacts.set(this.key(proposal, instructionSetHash), artifact);
  }

  async get(
    proposal: PublicKey,
    instructionSetHash: string,
  ): Promise<ProposalArtifact | null> {
    return this.artifacts.get(this.key(proposal, instructionSetHash)) ?? null;
  }
}
