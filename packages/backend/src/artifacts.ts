/**
 * Simulation/decode artifact store — spec 12.3.
 *
 * Artifacts are off-chain, keyed by (proposal, instruction-set hash). The
 * hash is computed over the canonical serialization of the instruction set
 * in EXECUTION ORDER, covering program ids, account keys with their
 * signer/writable flags, and instruction data — so any tamper or reorder
 * breaks the key and the UI badge turns red (INV-9/10).
 */
import type { PublicKey } from "@solana/web3.js";

// The hash itself lives in the sdk (the proposer publishes it as
// descriptionLink, D-017); re-exported here for the store's consumers.
export { computeInstructionSetHash } from "@daofun/sdk";

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
