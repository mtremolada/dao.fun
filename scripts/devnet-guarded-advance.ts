/**
 * Finish GATE L5's production-params proposal later, without me.
 *
 * `devnet-guarded-run.ts` (without `--fast`) necessarily stops at a cast vote:
 * production params are a 3-day voting window and a 72-hour hold-up, and a
 * live cluster's clock cannot be warped. This advances the SAME proposal by
 * whatever step time has made possible, so the gate's evidence can be
 * completed by running it again a few days later rather than re-launching a
 * DAO.
 *
 *   Voting    + window elapsed   -> finalize        (~3 days after the run)
 *   Succeeded + hold-up elapsed  -> execute         (~72h after finalizing)
 *   Completed                    -> nothing left
 *
 * The logic lives in scripts/lib/gov-advance.ts because `--fast` drives the
 * same two legs inside a single run; if this script had its own copy, the fast
 * proof would be a proof about different code.
 *
 * Everything is read from chain — pass only the proposal address. Running it
 * early is safe and free: it reports what is still pending and exits 0, so it
 * is fine to poll.
 *
 *   pnpm tsx scripts/devnet-guarded-advance.ts <proposal>
 */
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ProposalState } from "@solana/spl-governance";
import { advanceProposal, describeOutcome } from "./lib/gov-advance";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";

const signer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: devnet-guarded-advance.ts <proposal>");
  const proposalAddr = new PublicKey(arg);
  const connection = new Connection(RPC, "confirmed");

  const { ctx, outcome } = await advanceProposal(connection, signer(), proposalAddr);

  console.log(`proposal   ${proposalAddr.toBase58()}`);
  console.log(`state      ${ProposalState[ctx.proposal.state]}`);
  console.log(`governance ${ctx.governanceAddress.toBase58()}`);
  console.log(`realm      ${ctx.realm.toBase58()}`);
  console.log(`\n${describeOutcome(outcome)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
