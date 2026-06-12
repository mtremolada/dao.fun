/**
 * E2E backing API: the REAL backend handler (createApiHandler) with
 * in-memory stores, stubbed launch steps, and a fake ChainReader — the UI
 * is exercised against the same routing/validation code that runs in
 * production; only the on-chain reads/writes are stubbed.
 */
import { createServer } from "node:http";
import { PublicKey } from "@solana/web3.js";
import {
  MemoryArtifactStore,
  MemoryLaunchStore,
  createApiHandler,
  type ChainReader,
  type GovernanceTxSource,
} from "@daofun/backend";

const PORT = 4404;
const PROPOSAL = new PublicKey("11111111111111111111111111111111");
const HASH = "a".repeat(64);

// Chain-fed fixtures (see dashboard.spec.ts).
const CHAIN_PROPOSAL = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
// AUDIT F-8: a proposal whose on-chain instruction set could NOT be fully
// re-read (e.g. >cap transactions, or an adversarial truncation). The reader
// returns chainHash=null so the badge can never read "verified", and the
// `incomplete-instruction-set` anomaly carries the danger.
const INCOMPLETE_PROPOSAL = new PublicKey(
  "Vote111111111111111111111111111111111111111",
);
const REALM = new PublicKey("GRdkevbhSoJrnEtqadhvyuev81jSL99HYyhMCa3Tt8wR");
const VAULT = new PublicKey("8Z4PfwCARrz3DbJQpwy9vhmYz3xvokn9tZN1vsHq1kj9");

const ARTIFACT = {
  decodedSummary:
    "Transfer 0.00089088 SOL from the vault to the deployer (1 instruction)",
  simulation: { ok: true, unitsConsumed: 43931 },
  redFlags: ["drains the full vault balance"],
};

const chain: ChainReader = {
  async getProposalState(proposal) {
    if (proposal.equals(INCOMPLETE_PROPOSAL)) {
      return {
        proposal: proposal.toBase58(),
        name: "tampered: instruction set exceeds the readable range",
        state: "Voting",
        votingCompletedAt: null,
        holdUpSeconds: 72 * 3600,
        // fail-safe: no trustworthy hash over a partial executed set
        chainHash: null,
        publishedArtifactHash: HASH,
        instructionSetComplete: false,
        singleOption: true,
        vetoVoteWeight: "0",
        vetoed: false,
      };
    }
    if (!proposal.equals(CHAIN_PROPOSAL)) return null;
    return {
      proposal: proposal.toBase58(),
      name: "GATE1-p2: sweep vault via custody chain",
      state: "Completed",
      votingCompletedAt: Math.floor(Date.now() / 1000) - 100,
      holdUpSeconds: 0,
      chainHash: HASH,
      publishedArtifactHash: HASH,
      instructionSetComplete: true,
      singleOption: true,
      vetoVoteWeight: "0",
      vetoed: false,
    };
  },
  async getDashboard(realm, opts) {
    if (!realm.equals(REALM) || !opts.vault.equals(VAULT)) return null;
    return {
      realm: realm.toBase58(),
      realmName: "dao-fun-e2e-realm",
      vault: opts.vault.toBase58(),
      vaultBalanceLamports: 890_880,
      sweeps: [
        {
          signature: "stub-sig-sweep-1",
          blockTime: Math.floor(Date.now() / 1000) - 600,
          deltaLamports: 890_880,
        },
        {
          signature: "stub-sig-exec-2",
          blockTime: Math.floor(Date.now() / 1000) - 60,
          deltaLamports: -890_880,
        },
      ],
      votePower: opts.wallet
        ? { wallet: opts.wallet.toBase58(), depositedTokens: "200000000000" }
        : null,
    };
  },
};

// Browser-signing seam (D-028): the unsigned tx is a marker payload; the
// fake wallet in wallet.spec.ts prepends "SIGNED:"; submit verifies the
// round-trip so the e2e proves the BYTES flowed app -> wallet -> app.
const UNSIGNED_MARKER = "UNSIGNED-VOTE-TX";
const txs: GovernanceTxSource = {
  async depositTx() {
    return {
      txBase64: Buffer.from("UNSIGNED-DEPOSIT-TX").toString("base64"),
      tokenOwnerRecord: "stub-tor",
    };
  },
  async castVoteTx(req) {
    return {
      txBase64: Buffer.from(
        `${UNSIGNED_MARKER}:${req.proposal.toBase58()}:${req.approve ? "yes" : "no"}`,
      ).toString("base64"),
    };
  },
  async submit(signedTxBase64) {
    const payload = Buffer.from(signedTxBase64, "base64").toString("utf8");
    return {
      signature: payload.startsWith(`SIGNED:${UNSIGNED_MARKER}:`)
        ? "E2E-FAKE-SIGNATURE"
        : `REJECTED:${payload}`,
    };
  },
};

async function main() {
  const artifactStore = new MemoryArtifactStore();
  await artifactStore.put(PROPOSAL, HASH, ARTIFACT);
  // The chain-fed proposal resolves its artifact via the recomputed hash.
  await artifactStore.put(CHAIN_PROPOSAL, HASH, ARTIFACT);
  // F-8: the tampered proposal DID publish an artifact, but the chain set
  // could not be fully re-read — the badge must still refuse to verify.
  await artifactStore.put(INCOMPLETE_PROPOSAL, HASH, ARTIFACT);

  const handler = createApiHandler({
    launchStore: new MemoryLaunchStore(),
    artifactStore,
    chain,
    txs,
    buildSteps: () => [
      { name: "create-token", run: async () => ["stub-sig-create-token"] },
      { name: "create-treasury", run: async () => ["stub-sig-create-treasury"] },
      { name: "create-dao", run: async () => ["stub-sig-create-dao"] },
    ],
  });

  createServer(handler).listen(PORT, () => {
    console.log(`stub api on :${PORT}`);
  });
}

void main();
