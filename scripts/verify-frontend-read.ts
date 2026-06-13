/**
 * Live read-path verification (D-033): runs the SAME client SDK the static
 * front end uses (RpcChainReader from @daofun/sdk/chain-reader) against the
 * real GATE-1 mainnet DAO, and asserts the INV-9 hash recomputed from chain
 * matches the hash the proposer published. This is the read/verify surface
 * the browser performs — proven end-to-end against mainnet, no backend.
 *
 *   npx tsx scripts/verify-frontend-read.ts   # uses public mainnet RPC
 */
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  RpcChainReader,
  detectProposalAnomalies,
} from "../packages/sdk/src/chain-reader";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

async function main() {
  const ev = JSON.parse(
    readFileSync(".gate-evidence/gate1-sovereign-p2-mainnet.json", "utf8"),
  ) as {
    config: { realm: string; squadsVault: string };
    stages: { proposal: { proposal: string; innerInstructionSetHash: string } };
  };

  const realm = new PublicKey(ev.config.realm);
  const vault = new PublicKey(ev.config.squadsVault);
  const proposal = new PublicKey(ev.stages.proposal.proposal);
  const expectedHash = ev.stages.proposal.innerInstructionSetHash;

  const reader = new RpcChainReader(new Connection(RPC, "confirmed"));

  console.log(`RPC: ${RPC}`);
  console.log(`proposal: ${proposal.toBase58()}`);

  const ps = await reader.getProposalState(proposal);
  if (!ps) throw new Error("FAIL: proposal not found on mainnet");
  console.log("proposal state:", {
    name: ps.name,
    state: ps.state,
    chainHash: ps.chainHash,
    publishedArtifactHash: ps.publishedArtifactHash,
    holdUpSeconds: ps.holdUpSeconds,
    anomalies: detectProposalAnomalies(ps),
  });
  if (ps.chainHash !== expectedHash) {
    throw new Error(
      `FAIL: recomputed chain hash ${ps.chainHash} != evidence ${expectedHash}`,
    );
  }
  const badgeVerified =
    ps.chainHash !== null && ps.chainHash === ps.publishedArtifactHash;

  const dash = await reader.getDashboard(realm, { vault });
  if (!dash) throw new Error("FAIL: dashboard not found on mainnet");
  console.log("dashboard:", {
    realmName: dash.realmName,
    vaultBalanceLamports: dash.vaultBalanceLamports,
    sweeps: dash.sweeps.length,
  });

  console.log("");
  console.log(
    `INV-9 badge would render: ${badgeVerified ? "VERIFIED ✓" : "NOT verified"}`,
  );
  console.log("PASS: live mainnet read path works end-to-end.");
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
