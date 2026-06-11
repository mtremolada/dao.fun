/**
 * GATE 0c — fee shares configurable at launch for a PDA creator (soft
 * gate, spec Section 7; risk flag D-007). Runs the REAL pump + PumpFees
 * binaries (dumped from mainnet) in bankrun:
 *
 * 1. Launch leg: a pump token is created with creator == the DAO's Squads
 *    vault PDA (INV-1 verified against the real pump binary), then the
 *    launcher attempts createFeeSharingConfig. The PumpFees program's only
 *    signer is `payer`, constrained to the coin creator — a PDA cannot
 *    sign a plain launch transaction, so the at-launch config is expected
 *    to FAIL. This settles D-007 on-chain either way.
 * 2. Governance leg: the SAME instruction succeeds when the vault PDA
 *    "signs" via invoke_signed through the governance-executed Squads
 *    chain — proposal -> vote -> hold-up -> execute, with
 *    createFeeSharingConfig + updateFeeShares {vault 90%, protocol 10%}
 *    as the inner set. If this passes, fee sharing is DAO-governable
 *    post-launch even though the at-launch path is closed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  PumpSdk,
  feeSharingConfigPda,
  type Shareholder,
} from "@pump-fun/pump-sdk";
import { ProposalState } from "@solana/spl-governance";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  MICRO_HOLDUP_S,
  TEST_TIMEOUT,
  balance,
  castCommunityYes,
  createDao,
  executeAll,
  finalizeAfterVotingWindow,
  proposeInner,
  send,
  sendExpectFail,
  startCtx,
  warpSeconds,
} from "./helpers/bankrun-harness";

const pumpAccounts = (
  JSON.parse(
    readFileSync(resolve(__dirname, "fixtures/pump-accounts.json"), "utf8"),
  ) as {
    address: string;
    owner: string;
    lamports: number;
    dataBase64: string;
  }[]
).map((a) => ({
  address: new PublicKey(a.address),
  info: {
    lamports: a.lamports,
    data: Buffer.from(a.dataBase64, "base64"),
    owner: new PublicKey(a.owner),
    executable: false,
  },
}));

function startPumpCtx() {
  return startCtx(
    [
      { name: "pump", programId: PUMP_PROGRAM_ID },
      { name: "pump_fees", programId: PUMP_FEES_PROGRAM_ID },
      { name: "pump_amm", programId: PUMP_AMM_PROGRAM_ID },
      { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
    ],
    pumpAccounts,
  );
}

const pumpSdk = new PumpSdk(); // offline builder/decoder

describe("GATE 0c — fee shares for a PDA creator (real binaries, bankrun)", () => {
  it(
    "at-launch config FAILS (D-007: payer must be the creator, a PDA cannot sign); the SAME config succeeds via the governance custody chain",
    async () => {
      const ctx = await startPumpCtx();
      const dao = await createDao(ctx, "cypherpunk");
      const protocolTreasury = Keypair.generate().publicKey;

      // ---- launch: real pump create_v2 with creator == the vault PDA
      const mint = Keypair.generate();
      const createIx = await pumpSdk.createV2Instruction({
        mint: mint.publicKey,
        name: "daofun gate0c",
        symbol: "G0C",
        uri: "https://x.test/g0c.json",
        creator: dao.vaultPda,
        user: ctx.payer.publicKey,
        mayhemMode: false,
      });
      await send(ctx, [createIx], [mint]);

      // INV-1 against the real binary: the curve's creator IS the vault PDA.
      const curveInfo = await ctx.banksClient.getAccount(
        // bondingCurvePda lives in the sdk; PumpSdk derives it internally —
        // recover it from the create ix accounts (writable, non-signer, owned
        // by pump after creation).
        createIx.keys[2]!.pubkey,
      );
      const curve = pumpSdk.decodeBondingCurve({
        executable: false,
        owner: PUMP_PROGRAM_ID,
        lamports: Number(curveInfo!.lamports),
        data: Buffer.from(curveInfo!.data),
      });
      expect(curve.creator.toBase58()).toBe(dao.vaultPda.toBase58());

      // ---- leg 1: the launcher (tx signer) tries to create the sharing
      // config within the launch ceremony. The instruction's payer is the
      // launcher — NOT the creator — and the program must refuse.
      const atLaunchIx = await pumpSdk.createFeeSharingConfig({
        creator: ctx.payer.publicKey, // sdk sets payer = this
        mint: mint.publicKey,
        pool: null,
      });
      const err = await sendExpectFail(ctx, [atLaunchIx], []);
      // The real binary: NotAuthorized (6016) from
      // create_fee_sharing_config — only the coin creator may create the
      // config, and the instruction's only signer is the payer.
      expect(err).toMatch(/NotAuthorized|not authorized/i);
      const configPda = feeSharingConfigPda(mint.publicKey);
      expect(await ctx.banksClient.getAccount(configPda)).toBeNull();

      // ---- leg 2: the same instructions, inner to the custody chain — the
      // vault PDA invoke_signs as payer/authority. Both instructions ride
      // ONE Squads vault transaction (atomic create+set); the account-heavy
      // message goes through the ExecutionAdapter's buffered chain, and the
      // execute insert is packed v0+ALT by the harness.
      await send(
        ctx,
        [
          // the vault pays the sharingConfig rent when it is the payer;
          // the treasury pays the Squads execution + buffer rent (D-016)
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.vaultPda,
            lamports: 20_000_000,
          }),
          SystemProgram.transfer({
            fromPubkey: ctx.payer.publicKey,
            toPubkey: dao.nativeTreasury,
            lamports: 12_000_000,
          }),
        ],
        [],
      );
      const shareholders: Shareholder[] = [
        { address: dao.vaultPda, shareBps: 9_000 },
        { address: protocolTreasury, shareBps: 1_000 },
      ];
      const inner = [
        await pumpSdk.createFeeSharingConfig({
          creator: dao.vaultPda,
          mint: mint.publicKey,
          pool: null,
        }),
        await pumpSdk.updateFeeShares({
          authority: dao.vaultPda,
          mint: mint.publicKey,
          currentShareholders: [dao.vaultPda],
          newShareholders: shareholders,
        }),
      ];

      const made = await proposeInner(
        ctx,
        dao,
        0,
        inner,
        "create + set fee shares vault 90 / protocol 10",
      );
      await castCommunityYes(ctx, dao, made.proposal);
      expect(await finalizeAfterVotingWindow(ctx, dao, made.proposal)).toBe(
        ProposalState.Succeeded,
      );
      await warpSeconds(ctx, MICRO_HOLDUP_S + 10);
      await executeAll(ctx, dao, made);

      // The sharing config exists and carries the voted split.
      const configInfo = await ctx.banksClient.getAccount(configPda);
      expect(configInfo).not.toBeNull();
      const config = pumpSdk.decodeSharingConfig({
        executable: false,
        owner: PUMP_FEES_PROGRAM_ID,
        lamports: Number(configInfo!.lamports),
        data: Buffer.from(configInfo!.data),
      });
      const decoded = config.shareholders.map((s) => ({
        address: s.address.toBase58(),
        shareBps: s.shareBps,
      }));
      expect(decoded).toEqual([
        { address: dao.vaultPda.toBase58(), shareBps: 9_000 },
        { address: protocolTreasury.toBase58(), shareBps: 1_000 },
      ]);
      expect(await balance(ctx, configPda)).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );
});
