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
import type { LaunchState, LaunchStore } from "./launch-machine";

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

/**
 * Sqlite-backed launch state, so a crash mid-launch yields a resumable record
 * (spec 6.6: state persisted after every step). The whole `LaunchState` is
 * stored as JSON keyed by launchId — only public material (signatures, step
 * names) ever lands here; no secret key is ever persisted.
 */
export class SqliteLaunchStore implements LaunchStore {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        launch_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  /** `sqlite:<path>` (same scheme as ARTIFACT_STORE). */
  static fromEnv(spec: string): SqliteLaunchStore {
    if (!spec.startsWith("sqlite:")) {
      throw new Error(`unsupported launch store "${spec}" — expected sqlite:<path>`);
    }
    return new SqliteLaunchStore(spec.slice("sqlite:".length));
  }

  async load(launchId: string): Promise<LaunchState | null> {
    const row = this.db
      .prepare(`SELECT state FROM launches WHERE launch_id = ?`)
      .get(launchId) as { state: string } | undefined;
    return row ? (JSON.parse(row.state) as LaunchState) : null;
  }

  async save(state: LaunchState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO launches (launch_id, state, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(launch_id) DO UPDATE SET
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(state.launchId, JSON.stringify(state), Date.now());
  }

  close(): void {
    this.db.close();
  }
}
