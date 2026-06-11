/**
 * E2E backing API: the REAL backend handler (createApiHandler) with
 * in-memory stores and stubbed launch steps — the UI is exercised against
 * the same routing/validation code that runs in production; only the
 * on-chain steps are stubbed.
 */
import { createServer } from "node:http";
import { PublicKey } from "@solana/web3.js";
import {
  MemoryArtifactStore,
  MemoryLaunchStore,
  createApiHandler,
} from "@daofun/backend";

const PORT = 4404;
const PROPOSAL = new PublicKey("11111111111111111111111111111111");
const HASH = "a".repeat(64);

async function main() {
  const artifactStore = new MemoryArtifactStore();
  await artifactStore.put(PROPOSAL, HASH, {
    decodedSummary:
      "Transfer 0.00089088 SOL from the vault to the deployer (1 instruction)",
    simulation: { ok: true, unitsConsumed: 43931 },
    redFlags: ["drains the full vault balance"],
  });

  const handler = createApiHandler({
    launchStore: new MemoryLaunchStore(),
    artifactStore,
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
