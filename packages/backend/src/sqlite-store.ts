/**
 * Sqlite-backed artifact store (spec 12.3; env contract Section 3:
 * `ARTIFACT_STORE=sqlite:<path>`). Uses Node 22's built-in node:sqlite —
 * no native build step, keeping the zero-signup/zero-toolchain promise.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PublicKey } from "@solana/web3.js";
import type { ArtifactStore, ProposalArtifact } from "./artifacts";

export class SqliteArtifactStore implements ArtifactStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        proposal TEXT NOT NULL,
        ix_set_hash TEXT NOT NULL,
        artifact TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (proposal, ix_set_hash)
      )
    `);
  }

  static fromEnv(artifactStore: string): SqliteArtifactStore {
    if (!artifactStore.startsWith("sqlite:")) {
      throw new Error(
        `unsupported ARTIFACT_STORE "${artifactStore}" — expected sqlite:<path>`,
      );
    }
    return new SqliteArtifactStore(artifactStore.slice("sqlite:".length));
  }

  async put(
    proposal: PublicKey,
    instructionSetHash: string,
    artifact: ProposalArtifact,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO artifacts (proposal, ix_set_hash, artifact, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(proposal, ix_set_hash) DO UPDATE SET
           artifact = excluded.artifact, updated_at = excluded.updated_at`,
      )
      .run(
        proposal.toBase58(),
        instructionSetHash,
        JSON.stringify(artifact),
        Date.now(),
      );
  }

  async get(
    proposal: PublicKey,
    instructionSetHash: string,
  ): Promise<ProposalArtifact | null> {
    const row = this.db
      .prepare(
        `SELECT artifact FROM artifacts WHERE proposal = ? AND ix_set_hash = ?`,
      )
      .get(proposal.toBase58(), instructionSetHash) as
      | { artifact: string }
      | undefined;
    return row ? (JSON.parse(row.artifact) as ProposalArtifact) : null;
  }

  close(): void {
    this.db.close();
  }
}
