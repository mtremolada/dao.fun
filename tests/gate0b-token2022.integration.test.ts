/**
 * GATE 0b — Token-2022 on the curve (soft gate, spec Section 7; narrowed
 * by D-004: create_v2 mints are ALREADY Token-2022, proven live by GATE
 * 0a — the open question is transfer-fee extensions). Real pump binaries
 * in bankrun:
 *
 * 1. Launch + TRADE leg: create_v2 with a PDA creator, then a real buy
 *    and a full sell-back against the curve. Asserts the mint is
 *    Token-2022, records exactly which extensions pump initializes, and
 *    verifies creator fees accrue in the creator vault (INV-8 surface).
 * 2. Transfer-fee leg: a Token-2022 mint pre-initialized with
 *    TransferFeeConfig is brought to create_v2 — pump creates and
 *    initializes the mint ITSELF, so a pre-existing mint account must be
 *    refused. If (1) shows no transfer-fee extension and (2) is refused,
 *    transfer-fee tokens structurally cannot exist on the curve →
 *    drop from scope per the gate's fail branch.
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  getAssociatedTokenAddressSync,
  getExtensionTypes,
  getMintLen,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import {
  GLOBAL_PDA,
  PumpSdk,
  getBuyTokenAmountFromSolAmount,
  getSellSolAmountFromTokenAmount,
} from "@pump-fun/pump-sdk";
import { PUMP_PROGRAM_ID } from "../packages/sdk/src/constants";
import { derivePumpCreatorVault } from "../packages/sdk/src/pda";
import { deriveTreasuryPdas } from "../packages/sdk/src/treasury";
import {
  TEST_TIMEOUT,
  balance,
  prefundMissingWritables,
  send,
  sendExpectFail,
  startPumpCtx,
} from "./helpers/bankrun-harness";

const pumpSdk = new PumpSdk(); // offline builder/decoder

type BankrunAccount = {
  executable: boolean;
  owner: PublicKey;
  lamports: number | bigint;
  data: Uint8Array;
};

function toAccountInfo(info: BankrunAccount): AccountInfo<Buffer> {
  return {
    executable: info.executable,
    owner: info.owner,
    lamports: Number(info.lamports),
    data: Buffer.from(info.data),
  };
}

describe("GATE 0b — Token-2022 on the curve (real binaries, bankrun)", () => {
  it(
    "a create_v2 token is Token-2022 and TRADES on the curve (buy + sell, creator fees accrue); pump initializes NO transfer-fee extension",
    async () => {
      const ctx = await startPumpCtx();
      // INV-1 shape: an off-curve PDA creator, like every launch
      const creator = deriveTreasuryPdas(Keypair.generate().publicKey).vaultPda;
      const mint = Keypair.generate();

      const createIx = await pumpSdk.createV2Instruction({
        mint: mint.publicKey,
        name: "daofun gate0b",
        symbol: "G0B",
        uri: "https://x.test/g0b.json",
        creator,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      await send(ctx, [createIx], [mint]);
      const curvePda = createIx.keys[2]!.pubkey;

      // The mint is Token-2022 — and pump does NOT give it a transfer fee.
      const mintInfo = await ctx.banksClient.getAccount(mint.publicKey);
      expect(mintInfo!.owner.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
      const unpacked = unpackMint(
        mint.publicKey,
        toAccountInfo(mintInfo!),
        TOKEN_2022_PROGRAM_ID,
      );
      const extensions = getExtensionTypes(unpacked.tlvData);
      expect(extensions).not.toContain(ExtensionType.TransferFeeConfig);

      // ---- TRADE: a third-party buy...
      const buyer = Keypair.generate();
      await send(
        ctx,
        [
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: buyer.publicKey,
            lamports: 2_000_000_000,
          }),
        ],
        [],
      );
      const global = pumpSdk.decodeGlobal(
        toAccountInfo((await ctx.banksClient.getAccount(GLOBAL_PDA))!),
      );
      const readCurve = async () => {
        const info = toAccountInfo((await ctx.banksClient.getAccount(curvePda))!);
        return { info, curve: pumpSdk.decodeBondingCurve(info) };
      };

      const buySol = new BN(100_000_000); // 0.1 SOL
      const { info: curveInfo, curve } = await readCurve();
      const buyIxs = await pumpSdk.buyInstructions({
        global,
        bondingCurveAccountInfo: curveInfo,
        bondingCurve: curve,
        associatedUserAccountInfo: null,
        mint: mint.publicKey,
        user: buyer.publicKey,
        amount: getBuyTokenAmountFromSolAmount({
          global,
          feeConfig: null,
          mintSupply: null,
          bondingCurve: curve,
          amount: buySol,
          quoteMint: NATIVE_MINT,
        }),
        solAmount: buySol,
        slippage: 5,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      });
      await prefundMissingWritables(ctx, buyIxs);
      await send(ctx, buyIxs, [buyer], buyer);

      const buyerAta = getAssociatedTokenAddressSync(
        mint.publicKey,
        buyer.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID,
      );
      const readAtaAmount = async () => {
        const info = await ctx.banksClient.getAccount(buyerAta);
        if (!info) return 0n;
        return unpackAccount(buyerAta, toAccountInfo(info), TOKEN_2022_PROGRAM_ID)
          .amount;
      };
      const bought = await readAtaAmount();
      expect(bought > 0n).toBe(true);

      // ...creator fees accrued to the PDA creator's vault on top of its
      // rent prefund (INV-8 surface)...
      const creatorVault = derivePumpCreatorVault(creator);
      const accruedAfterBuy = await balance(ctx, creatorVault);
      expect(accruedAfterBuy).toBeGreaterThan(890_880);

      // ...and a full sell-back.
      const after = await readCurve();
      const sellIxs = await pumpSdk.sellInstructions({
        global,
        bondingCurveAccountInfo: after.info,
        bondingCurve: after.curve,
        mint: mint.publicKey,
        user: buyer.publicKey,
        amount: new BN(bought.toString()),
        solAmount: getSellSolAmountFromTokenAmount({
          global,
          feeConfig: null,
          mintSupply: after.curve.tokenTotalSupply,
          bondingCurve: after.curve,
          amount: new BN(bought.toString()),
        }),
        slippage: 5,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        mayhemMode: false,
      });
      await prefundMissingWritables(ctx, sellIxs);
      const lamportsBeforeSell = await balance(ctx, buyer.publicKey);
      await send(ctx, sellIxs, [buyer], buyer);
      expect(await readAtaAmount()).toBe(0n);
      expect(await balance(ctx, buyer.publicKey)).toBeGreaterThan(
        lamportsBeforeSell,
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "a pre-initialized transfer-fee Token-2022 mint CANNOT enter the curve: create_v2 refuses an existing mint account",
    async () => {
      const ctx = await startPumpCtx();
      const tfMint = Keypair.generate();
      const mintLen = getMintLen([ExtensionType.TransferFeeConfig]);
      const rent = await ctx.banksClient.getRent();
      const lamports = Number(await rent.minimumBalance(BigInt(mintLen)));

      await send(
        ctx,
        [
          SystemProgram.createAccount({
            fromPubkey: ctx.payer.publicKey,
            newAccountPubkey: tfMint.publicKey,
            lamports,
            space: mintLen,
            programId: TOKEN_2022_PROGRAM_ID,
          }),
          createInitializeTransferFeeConfigInstruction(
            tfMint.publicKey,
            ctx.payer.publicKey,
            ctx.payer.publicKey,
            100, // 1% transfer fee
            1_000_000_000n,
            TOKEN_2022_PROGRAM_ID,
          ),
          createInitializeMint2Instruction(
            tfMint.publicKey,
            6,
            ctx.payer.publicKey,
            null,
            TOKEN_2022_PROGRAM_ID,
          ),
        ],
        [tfMint],
      );
      // sanity: the mint really carries the extension
      const tfInfo = await ctx.banksClient.getAccount(tfMint.publicKey);
      expect(
        getExtensionTypes(
          unpackMint(tfMint.publicKey, toAccountInfo(tfInfo!), TOKEN_2022_PROGRAM_ID)
            .tlvData,
        ),
      ).toContain(ExtensionType.TransferFeeConfig);

      // pump creates and initializes the mint itself — a pre-existing mint
      // account must be refused, so transfer-fee mints can never reach the
      // curve. GATE 0b verdict: drop transfer-fee support from scope.
      const createIx = await pumpSdk.createV2Instruction({
        mint: tfMint.publicKey,
        name: "transfer fee coin",
        symbol: "TFC",
        uri: "https://x.test/tfc.json",
        creator: deriveTreasuryPdas(Keypair.generate().publicKey).vaultPda,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      const err = await sendExpectFail(ctx, [createIx], [tfMint]);
      expect(err).toMatch(/already in use|already.*initialized|invalid account data/i);
      // and no bonding curve was created for it
      expect(
        await ctx.banksClient.getAccount(createIx.keys[2]!.pubkey),
      ).toBeNull();
      void PUMP_PROGRAM_ID; // referenced for clarity of the program under test
    },
    TEST_TIMEOUT,
  );
});
