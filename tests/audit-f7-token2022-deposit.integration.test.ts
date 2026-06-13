/**
 * AUDIT F-7 (HIGH) — the browser deposit builder must produce a WORKING
 * governing-token deposit for the Token-2022 mints the launchpad always
 * launches. This is the deposit-side twin of F-1: F-1 made the DAO stand up;
 * F-7 makes its holders actually able to gain vote weight through the product.
 *
 * Root cause (pre-fix): `buildDepositGoverningTokensTx` emitted the 0.3.28
 * client's deposit verbatim — the CLASSIC Token program on the transfer and NO
 * mint account. The deployed spl-governance v3.1.4 fork rejects that for a
 * Token-2022 governing mint ("Expected mint account is required for Token-2022
 * deposits and withdrawals"), so a browser deposit reverted and the holder got
 * ZERO vote weight — governance was unreachable through the product's own path
 * for every pump `create_v2` (Token-2022) launch.
 *
 * Fix: the builder retargets the token program to Token-2022 and appends the
 * mint (the patch proven on mainnet by scripts/mainnet-gate1-sovereign.ts).
 *
 * Proof on the deployed binaries: in the production no-addin Token-2022 realm,
 *   - the PRE-FIX deposit shape (classic program, no mint) REVERTS on chain;
 *   - the FIXED builder's deposit SUCCEEDS and the holder's TokenOwnerRecord
 *     records exactly the deposited amount as vote weight.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  TokenOwnerRecord,
  getTokenOwnerRecordAddress,
  withDepositGoverningTokens,
} from "@solana/spl-governance";
import { start, type ProgramTestContext } from "solana-bankrun";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import { buildCreateDaoIxs } from "../packages/sdk/src/governance";
import { resolveGovernanceParams } from "../packages/sdk/src/matrix";
import { buildDepositGoverningTokensTx } from "../packages/backend/src/tx-builder";
import {
  BASE_VOTING_TIME_S,
  PROGRAM_VERSION,
  SUPPLY,
  TEST_TIMEOUT,
  readGov,
  send,
  sendExpectFail,
} from "./helpers/bankrun-harness";

async function ctxWithGov(): Promise<ProgramTestContext> {
  return start(
    [
      { name: "spl_governance", programId: SPL_GOVERNANCE_PROGRAM_ID },
      { name: "vsr", programId: VSR_PROGRAM_ID },
      { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
    ],
    [],
  );
}

/** Mint a Token-2022 community mint and give the voter the full supply. */
async function token2022MintTo(
  ctx: ProgramTestContext,
  voter: PublicKey,
): Promise<{ mint: PublicKey; voterAta: PublicKey }> {
  const mint = Keypair.generate();
  const rent = await ctx.banksClient.getRent();
  const lamports = Number(await rent.minimumBalance(BigInt(MINT_SIZE)));
  const voterAta = getAssociatedTokenAddressSync(
    mint.publicKey,
    voter,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  await send(
    ctx,
    [
      SystemProgram.createAccount({
        fromPubkey: ctx.payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports,
        space: MINT_SIZE,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        mint.publicKey,
        6,
        ctx.payer.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.payer.publicKey,
        voterAta,
        voter,
        mint.publicKey,
        TOKEN_2022_PROGRAM_ID,
      ),
      createMintToInstruction(
        mint.publicKey,
        voterAta,
        ctx.payer.publicKey,
        SUPPLY,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    ],
    [mint],
  );
  return { mint: mint.publicKey, voterAta };
}

describe("AUDIT F-7 (fixed): browser Token-2022 governing deposit works on the real binary", () => {
  it(
    "the pre-fix deposit reverts; the fixed builder lands vote weight in the TokenOwnerRecord",
    async () => {
      const ctx = await ctxWithGov();
      const voter = Keypair.generate();
      // fund the voter so the on-chain TOR rent (paid by the wallet) is never
      // the reason a leg fails — the only variable is the Token-2022 adaptation.
      await send(ctx, [
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: voter.publicKey,
          lamports: 1_000_000_000,
        }),
      ], []);

      const { mint, voterAta } = await token2022MintTo(ctx, voter.publicKey);

      // Stand up the production no-addin Token-2022 realm (the F-1 fix).
      const params = resolveGovernanceParams({
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
      });
      const dao = await buildCreateDaoIxs({
        mint,
        payer: ctx.payer.publicKey,
        mode: "cypherpunk",
        params,
        baseVotingTimeSeconds: BASE_VOTING_TIME_S,
        communityTokenProgram: TOKEN_2022_PROGRAM_ID,
      });
      await send(ctx, dao.groups.realmSetup, []);
      await send(ctx, dao.groups.governanceSetup, []);

      // ---- PRE-FIX shape: Token-2022 source ATA, but classic program + no
      // mint (exactly what the product emitted before F-7) — must REVERT. ----
      const legacyIxs: Transaction["instructions"] = [];
      await withDepositGoverningTokens(
        legacyIxs,
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        dao.realm,
        voterAta,
        mint,
        voter.publicKey,
        voter.publicKey,
        voter.publicKey,
        new BN(SUPPLY.toString()),
      );
      const err = await sendExpectFail(ctx, legacyIxs, [voter]);
      expect(err.length).toBeGreaterThan(0);

      // ---- FIXED builder: retarget + mint-append — must SUCCEED. ----
      const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
      const built = await buildDepositGoverningTokensTx({
        realm: dao.realm,
        governingTokenMint: mint,
        wallet: voter.publicKey,
        amount: SUPPLY,
        blockhash,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });
      const depositTx = Transaction.from(Buffer.from(built.txBase64, "base64"));
      await send(ctx, depositTx.instructions, [voter], voter);

      // The holder now has vote weight equal to exactly the deposited amount.
      const torAddr = await getTokenOwnerRecordAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        dao.realm,
        mint,
        voter.publicKey,
      );
      const tor = await readGov(ctx, torAddr, TokenOwnerRecord);
      expect(tor.governingTokenDepositAmount.toString()).toBe(SUPPLY.toString());
      expect(built.tokenOwnerRecord).toBe(torAddr.toBase58());
    },
    TEST_TIMEOUT,
  );
});
