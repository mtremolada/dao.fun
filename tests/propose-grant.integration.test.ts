/**
 * Client-side proposal CREATION on the real binaries (bankrun). Proves the
 * browser path (buildCreateGrantProposal) assembles a grant proposal that the
 * deployed SPL-Governance + Squads binaries accept end-to-end: create -> insert
 * -> sign-off -> community YES -> finalize (Succeeded) -> hold-up -> execute, and
 * the recipient is funded by exactly the granted amount, from the DAO vault,
 * only after the vote carried. This is the create counterpart to the execute
 * coverage and the safety gate for shipping the proposal UI.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  ProposalState,
  getProposalTransactionAddress,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import { SQUADS_V4_PROGRAM_ID, SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import { buildCreateGrantProposal } from "../packages/sdk/src/proposal-create";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  send,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const PROGRAM_VERSION = 3;

describe("client-side grant proposal creation (real binaries, bankrun)", () => {
  it(
    "buildCreateGrantProposal -> vote -> execute funds the recipient from the vault, only after passing",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");

      // Default funding leaves the vault at exactly the rent floor; add headroom
      // so a guarded grant (D-009: must leave the floor behind) is spendable.
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.vaultPda,
            lamports: 2_000_000_000,
          }),
        ],
        [],
      );
      const vaultBalanceLamports = BigInt(await balance(ctx, dao.vaultPda));
      const GRANT = 500_000_000n;

      // The Squads transactionIndex (+1) — read exactly as the browser resolver does.
      const msAcct = (await ctx.banksClient.getAccount(dao.multisigPda))!;
      const [ms] = multisig.accounts.Multisig.fromAccountInfo({
        executable: false,
        owner: SQUADS_V4_PROGRAM_ID,
        lamports: Number(msAcct.lamports),
        data: Buffer.from(msAcct.data),
      });
      const transactionIndex = BigInt(ms.transactionIndex.toString()) + 1n;

      const recipient = Keypair.generate().publicKey;
      const made = await buildCreateGrantProposal({
        realm: dao.realm,
        governance: dao.governance,
        governingTokenMint: dao.mint,
        nativeTreasury: dao.nativeTreasury,
        multisig: dao.multisigPda,
        vault: dao.vaultPda,
        proposer: dao.voter.publicKey,
        tokenOwnerRecord: dao.voterTor,
        recipient,
        lamports: GRANT,
        vaultBalanceLamports,
        proposalIndex: 0,
        transactionIndex,
        holdUpSeconds: dao.params.holdUpSeconds,
        name: "grant 0.5 SOL to a contributor",
      });

      // Send the ceremony the browser would send: create, each insert, sign-off.
      await send(ctx, made.groups.create, [dao.voter], dao.voter);
      const ptAddrs: PublicKey[] = [];
      for (const [i, group] of made.groups.inserts.entries()) {
        await send(ctx, group, [dao.voter], dao.voter);
        ptAddrs.push(
          await getProposalTransactionAddress(
            SPL_GOVERNANCE_PROGRAM_ID,
            PROGRAM_VERSION,
            made.proposal,
            0,
            i,
          ),
        );
      }
      await send(ctx, made.groups.signOff, [dao.voter], dao.voter);

      // Vote it through and finalize.
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );

      // Before the hold-up elapses the recipient has nothing.
      expect(await balance(ctx, recipient)).toBe(0);

      // After the hold-up, anyone executes and the grant lands — exact amount.
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, {
        proposal: made.proposal,
        wrapped: made.wrapped,
        ptAddrs,
        innerHash: made.innerInstructionSetHash,
        recipient,
      });
      expect(BigInt(await balance(ctx, recipient))).toBe(GRANT);
    },
    TEST_TIMEOUT,
  );
});
