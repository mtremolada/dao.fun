/**
 * Live (read-only) frontend backing API against MAINNET — serves the real
 * createApiHandler with the RpcChainReader pointed at the GATE 1 phase-2
 * DAO. The artifact store is seeded with the artifact the gate run
 * published (hash from .gate-evidence), so the proposal view's badge is
 * verified against the hash RECOMPUTED from chain. No transactions are
 * sent; this reads accounts only.
 *
 *   npx tsx scripts/serve-frontend-mainnet.ts   # API on :4404
 *   (cd app && API_URL=http://127.0.0.1:4404 npx next start -p 3210)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  MemoryArtifactStore,
  MemoryLaunchStore,
  RpcChainReader,
  createApiHandler,
} from "../packages/backend/src";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PORT = 4404;

const evidence = JSON.parse(
  readFileSync(".gate-evidence/gate1-sovereign-p2-mainnet.json", "utf8"),
) as {
  stages: Record<string, Record<string, unknown>>;
};

const proposal = new PublicKey(evidence.stages["proposal"]!.proposal as string);
const artifactHash = evidence.stages["proposal"]!
  .innerInstructionSetHash as string;

async function main() {
  const artifactStore = new MemoryArtifactStore();
  // The artifact the gate run published for its inner instruction set:
  // one SystemProgram.transfer sweeping the vault to the deployer.
  await artifactStore.put(proposal, artifactHash, {
    decodedSummary:
      "Transfer 0.00089088 SOL (890880 lamports) from the Squads vault " +
      "8Z4PfwCARrz3DbJQpwy9vhmYz3xvokn9tZN1vsHq1kj9 to the deployer (1 instruction)",
    simulation: { ok: true, note: "executed live 2026-06-11; see GATES.md" },
    redFlags: ["drains the full vault balance"],
  });

  const handler = createApiHandler({
    launchStore: new MemoryLaunchStore(),
    artifactStore,
    chain: new RpcChainReader(new Connection(RPC, "confirmed")),
    // Read-only demo server: launches are not wired to mainnet here.
    buildSteps: () => [
      {
        name: "refuse",
        run: async () => {
          throw new Error("read-only demo server — launches disabled");
        },
      },
    ],
  });

  createServer(handler).listen(PORT, () => {
    console.log(`mainnet read-only api on :${PORT} (rpc ${RPC})`);
    console.log(`proposal ${proposal.toBase58()} artifact ${artifactHash}`);
  });
}

void main();
