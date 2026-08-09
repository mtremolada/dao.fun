/**
 * Finish GATE L5 later, without me.
 *
 * `devnet-guarded-run.ts` necessarily stops at a cast vote: production params
 * are a 3-day voting window and a 72-hour hold-up, and a live cluster's clock
 * cannot be warped. This advances the SAME proposal by whatever step time has
 * made possible, so the gate's evidence can be completed by running it again
 * a few days later rather than re-launching a DAO.
 *
 *   Voting    + window elapsed   -> finalize        (~3 days after the run)
 *   Succeeded + hold-up elapsed  -> execute         (~72h after finalizing)
 *   Completed                    -> nothing left
 *
 * Everything is read from chain — pass only the proposal address. Running it
 * early is safe and free: it reports what is still pending and exits 0, so it
 * is fine to poll.
 *
 *   pnpm tsx scripts/devnet-guarded-advance.ts <proposal>
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  Governance,
  GovernanceAccountParser,
  Proposal,
  ProposalState,
  ProposalTransaction,
  createInstructionData,
  getProposalTransactionAddress,
  withExecuteTransaction,
  withFinalizeVote,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_VERSION = 3;

const signer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

async function readAccount<T>(
  connection: Connection,
  address: PublicKey,
  cls: new (args: never) => T,
): Promise<T> {
  const info = await connection.getAccountInfo(address);
  if (!info) throw new Error(`no account at ${address.toBase58()}`);
  return GovernanceAccountParser(cls)(address, info).account as T;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) throw new Error("usage: devnet-guarded-advance.ts <proposal>");
  const proposalAddr = new PublicKey(arg);
  const connection = new Connection(RPC, "confirmed");
  const payer = signer();

  const proposal = await readAccount(connection, proposalAddr, Proposal);
  const governanceAddr = proposal.governance;
  const governance = await readAccount(connection, governanceAddr, Governance);
  const now = Math.floor(Date.now() / 1000);

  console.log(`proposal   ${proposalAddr.toBase58()}`);
  console.log(`state      ${ProposalState[proposal.state]}`);
  console.log(`governance ${governanceAddr.toBase58()}`);
  console.log(`realm      ${governance.realm.toBase58()}`);

  const send = (ixs: TransactionInstruction[]) =>
    sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ...ixs,
      ),
      [payer],
      { commitment: "confirmed" },
    );

  if (proposal.state === ProposalState.Voting) {
    // votingAt is set at sign-off; the window is the governance's base time.
    const votingAt = Number(proposal.votingAt ?? 0);
    const endsAt = votingAt + governance.config.baseVotingTime;
    if (now < endsAt) {
      const left = endsAt - now;
      console.log(
        `\nstill VOTING — ${Math.ceil(left / 3600)}h to go ` +
          `(window ends ${new Date(endsAt * 1000).toISOString()}). Nothing to do yet.`,
      );
      return;
    }
    const ixs: TransactionInstruction[] = [];
    await withFinalizeVote(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      governance.realm,
      governanceAddr,
      proposalAddr,
      // The proposal is OWNED by the gate's council record — passing the
      // proposer's would be refused with "Invalid Proposal Owner".
      proposal.tokenOwnerRecord,
      proposal.governingTokenMint,
    );
    console.log(`\nfinalize   ${await send(ixs)}`);
    const after = await readAccount(connection, proposalAddr, Proposal);
    console.log(`state      ${ProposalState[after.state]}`);
    return;
  }

  if (proposal.state === ProposalState.Succeeded) {
    const signedOff = Number(proposal.signingOffAt ?? 0);
    void signedOff;
    const votingCompletedAt = Number(proposal.votingCompletedAt ?? 0);
    const holdUp = governance.config.minInstructionHoldUpTime;
    const executableAt = votingCompletedAt + holdUp;
    if (now < executableAt) {
      console.log(
        `\nSUCCEEDED, in hold-up — ${Math.ceil((executableAt - now) / 3600)}h to go ` +
          `(executable ${new Date(executableAt * 1000).toISOString()}).`,
      );
      return;
    }
    // One ProposalTransaction per index; option 0 only (single-choice).
    for (let i = 0; i < 16; i++) {
      const ptAddr = await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        proposalAddr,
        0,
        i,
      );
      const info = await connection.getAccountInfo(ptAddr);
      if (!info) break;
      const pt = GovernanceAccountParser(ProposalTransaction)(ptAddr, info).account;
      const inner = pt.getAllInstructions().map((d) =>
        createInstructionData(
          new TransactionInstruction({
            programId: d.programId,
            keys: d.accounts.map((a) => ({
              pubkey: a.pubkey,
              isSigner: a.isSigner,
              isWritable: a.isWritable,
            })),
            data: Buffer.from(d.data),
          }),
        ),
      );
      const ixs: TransactionInstruction[] = [];
      await withExecuteTransaction(
        ixs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        governanceAddr,
        proposalAddr,
        ptAddr,
        inner,
      );
      console.log(`execute[${i}] ${await send(ixs)}`);
    }
    const after = await readAccount(connection, proposalAddr, Proposal);
    console.log(`state      ${ProposalState[after.state]}`);
    return;
  }

  console.log("\nnothing to advance from this state.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
