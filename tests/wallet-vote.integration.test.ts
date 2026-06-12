/**
 * Browser-signing seam (D-028) against the REAL spl-governance binary:
 * the backend's UNSIGNED transactions (deposit + cast-vote), signed the
 * way a wallet signs — raw bytes, no builder context — are accepted on
 * chain and the vote COUNTS.
 *
 *   1. A fresh holder receives half the supply; its deposit tx comes from
 *      buildDepositGoverningTokensTx, is deserialized from base64, signed
 *      by the holder alone, re-serialized, and submitted as raw bytes.
 *   2. The voter proposes a sweep; the holder approves it through
 *      buildCastVoteTx the same way.
 *   3. The proposal finalizes Succeeded on the holder's vote alone, and
 *      the recorded yes weight equals exactly the deposited amount.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import { Keypair, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Proposal,
  ProposalState,
  withDepositGoverningTokens,
  withWithdrawGoverningTokens,
} from "@solana/spl-governance";
import { SPL_GOVERNANCE_PROGRAM_ID } from "../packages/sdk/src/constants";
import {
  buildCastVoteTx,
  buildDepositGoverningTokensTx,
} from "../packages/backend/src/tx-builder";
import {
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  createDao,
  finalizeAfterVotingWindow,
  proposeSweep,
  readGov,
  send,
  startCtx,
} from "./helpers/bankrun-harness";
import type { ProgramTestContext } from "solana-bankrun";

const HALF = SUPPLY / 2n;

/** What a wallet does: bytes in, signature added, bytes out. */
function walletSign(unsignedTxBase64: string, wallet: Keypair): string {
  const tx = Transaction.from(Buffer.from(unsignedTxBase64, "base64"));
  tx.partialSign(wallet);
  return tx.serialize().toString("base64");
}

/** What the backend submit endpoint does: raw signed bytes to the chain. */
async function submitRaw(ctx: ProgramTestContext, signedTxBase64: string) {
  await ctx.banksClient.processTransaction(
    Transaction.from(Buffer.from(signedTxBase64, "base64")),
  );
}

describe("D-028 browser-signing seam (real binary, bankrun)", () => {
  it(
    "a holder deposits and votes through backend-built, wallet-signed transactions; the vote counts exactly",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");
      const browserHolder = Keypair.generate();

      // ---- stage: move half the supply to the browser holder ----
      // (createDao deposited the full supply for the voter; withdraw it,
      // split it, re-deposit the voter's half the plain way)
      const voterAta = getAssociatedTokenAddressSync(
        dao.mint,
        dao.voter.publicKey,
      );
      const holderAta = getAssociatedTokenAddressSync(
        dao.mint,
        browserHolder.publicKey,
      );
      const stage: TransactionInstruction[] = [];
      await withWithdrawGoverningTokens(
        stage,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voterAta,
        dao.mint,
        dao.voter.publicKey,
      );
      stage.push(
        createAssociatedTokenAccountIdempotentInstruction(
          ctx.payer.publicKey,
          holderAta,
          browserHolder.publicKey,
          dao.mint,
        ),
        createTransferInstruction(
          voterAta,
          holderAta,
          dao.voter.publicKey,
          HALF,
        ),
      );
      await withDepositGoverningTokens(
        stage,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voterAta,
        dao.mint,
        dao.voter.publicKey,
        dao.voter.publicKey,
        ctx.payer.publicKey,
        new BN((SUPPLY - HALF).toString()),
      );
      await send(ctx, stage, [dao.voter]);
      await send(
        ctx,
        [
          // the browser wallet pays its own fees and rent
          (await import("@solana/web3.js")).SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: browserHolder.publicKey,
            lamports: 100_000_000,
          }),
        ],
        [],
      );

      // ---- browser flow 1: deposit via the seam ----
      const [blockhash1] = (await ctx.banksClient.getLatestBlockhash())!;
      const depositTx = await buildDepositGoverningTokensTx({
        realm: dao.realm,
        governingTokenMint: dao.mint,
        wallet: browserHolder.publicKey,
        amount: HALF,
        blockhash: blockhash1,
      });
      await submitRaw(ctx, walletSign(depositTx.txBase64, browserHolder));

      // ---- the voter proposes a sweep ----
      const made = await proposeSweep(ctx, dao, 0);

      // ---- browser flow 2: approve via the seam ----
      const [blockhash2] = (await ctx.banksClient.getLatestBlockhash())!;
      const voteTx = await buildCastVoteTx({
        realm: dao.realm,
        governance: dao.governance,
        proposal: made.proposal,
        proposalOwnerRecord: dao.voterTor,
        governingTokenMint: dao.mint,
        wallet: browserHolder.publicKey,
        blockhash: blockhash2,
        approve: true,
      });
      await submitRaw(ctx, walletSign(voteTx.txBase64, browserHolder));

      // the vote counted: exactly the holder's deposited weight, and the
      // proposal passes quorum (50% yes >= the 25% micro floor) on it
      const onChain = await readGov(ctx, made.proposal, Proposal);
      expect(onChain.options[0]!.voteWeight.toString()).toBe(HALF.toString());
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );
    },
    TEST_TIMEOUT,
  );
});
