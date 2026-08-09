/**
 * GATE L1 leg 1 — the global config account (SPEC-LAUNCHPAD.md §1/§2).
 *
 * Proves that OUR compiled program loads and executes in the same bankrun
 * harness as the deployed binaries, that the graduation-CPI dependency
 * links, and that the config account comes out with the exact byte layout
 * the SDK will decode. This is the D-029 sequencing applied to the
 * launchpad: pin the pipeline before trusting anything built on it.
 *
 * It also pins the guards on the one instruction an operator can call
 * directly — the fee band and the "can this curve afford to graduate"
 * check — because those bound what a compromised authority could do.
 *
 * Fixture rebuild command: see tests/helpers/launchpad-harness.ts.
 * Run: pnpm test:integration
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ComputeBudgetProgram, Keypair, PublicKey } from "@solana/web3.js";
import type { ProgramTestContext } from "solana-bankrun";
import {
  PUMP_CLASSIC,
  type CurveParams,
} from "../packages/sdk/src/curve-math";
import {
  RAYDIUM_CPMM_AMM_CONFIG,
  RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../packages/sdk/src/constants";
import { TEST_TIMEOUT, send, sendExpectFail } from "./helpers/bankrun-harness";
import {
  buildSetGraduationConfigIx,
  configLocksLiquidity,
  decodeConfig,
} from "../packages/sdk/src/launchpad";
import {
  LAUNCHPAD_PROGRAM_ID,
  configPda,
  initializeConfigIx,
  startLaunchpadCtx,
  updateConfigIx,
} from "./helpers/launchpad-harness";

const accountDisc = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

describe("launchpad-curve — global config", () => {
  let ctx: ProgramTestContext;
  const authority = Keypair.generate();
  const feeRecipient = Keypair.generate();
  let cuNonce = 0;
  const cu = () =>
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 + cuNonce++ });

  beforeAll(async () => {
    ctx = await startLaunchpadCtx();
  }, TEST_TIMEOUT);

  it(
    "creates the config PDA with the declared layout",
    async () => {
      await send(
        ctx,
        [
          cu(),
          initializeConfigIx({
            payer: ctx.payer.publicKey,
            authority: authority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            params: PUMP_CLASSIC,
          }),
        ],
        [authority],
      );

      const [config, bump] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        LAUNCHPAD_PROGRAM_ID,
      );
      expect(config.toBase58()).toBe(configPda().toBase58());
      const info = await ctx.banksClient.getAccount(config);
      expect(new PublicKey(info!.owner).toBase58()).toBe(
        LAUNCHPAD_PROGRAM_ID.toBase58(),
      );

      // Decoded by byte offset, exactly as the SDK will read it — no anchor
      // TS client anywhere in this repo's tests, so a layout change shows up
      // here rather than being absorbed by a regenerated IDL.
      const d = Buffer.from(info!.data);
      expect([...d.subarray(0, 8)]).toEqual([...accountDisc("Config")]);
      expect(new PublicKey(d.subarray(8, 40)).toBase58()).toBe(
        authority.publicKey.toBase58(),
      );
      expect(new PublicKey(d.subarray(40, 72)).toBase58()).toBe(
        feeRecipient.publicKey.toBase58(),
      );
      expect(d.readUInt16LE(72)).toBe(70); // protocol: 0.70%
      expect(d.readUInt16LE(74)).toBe(30); // creator:  0.30%
      expect(d.readBigUInt64LE(76)).toBe(0n); // graduation fee, off by default
      expect(d.readBigUInt64LE(84)).toBe(PUMP_CLASSIC.initialVirtualSol);
      expect(d.readBigUInt64LE(92)).toBe(PUMP_CLASSIC.initialVirtualToken);
      expect(d.readBigUInt64LE(100)).toBe(PUMP_CLASSIC.initialRealToken);
      expect(d.readBigUInt64LE(108)).toBe(PUMP_CLASSIC.tokenTotalSupply);
      // The three Raydium addresses, immutable from here on.
      expect(new PublicKey(d.subarray(116, 148)).toBase58()).toBe(
        RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
      );
      expect(new PublicKey(d.subarray(148, 180)).toBase58()).toBe(
        RAYDIUM_CPMM_AMM_CONFIG.toBase58(),
      );
      expect(new PublicKey(d.subarray(180, 212)).toBase58()).toBe(
        RAYDIUM_CPMM_CREATE_POOL_FEE_RECEIVER.toBase58(),
      );
      expect(d[212]).toBe(bump);
      // A fresh config selects the BURN branch: lock_program all-zero. That
      // is both the safe default and devnet's only possible behaviour.
      expect(new PublicKey(d.subarray(213, 245)).equals(PublicKey.default)).toBe(
        true,
      );
      expect(d.readUInt16LE(245)).toBe(0);
      // 8 disc + 32 + 32 + 2 + 2 + 8*5 + 32*3 + 1 bump + 64 tail.
      // The tail was originally `reserved: [u64; 8]`; lock_program (32) and
      // graduated_fee_protocol_bps (2) were carved OUT of it, so this length
      // must not move — a config account written by the previous deployment
      // has to keep deserializing, and it does, as burn + zero share.
      expect(d.length).toBe(277);
    },
    TEST_TIMEOUT,
  );

  it(
    "lets the authority pick the Raydium fee tier, but only a Raydium one",
    async () => {
      // The tier is the DAO's perpetual income rate (research/launchpad/
      // graduation-economics.md §3): index 0 pays the locked position 0.210%
      // of volume, index 1 pays 0.840% for the same 0.15 SOL. It has to be
      // changeable without a redeploy, which is why this instruction exists.
      await send(
        ctx,
        [
          cu(),
          buildSetGraduationConfigIx({
            authority: authority.publicKey,
            ammConfig: RAYDIUM_CPMM_AMM_CONFIG,
            lockProgram: PublicKey.default,
            graduatedFeeProtocolBps: 2_000,
          }),
        ],
        [authority],
      );
      const cfg = decodeConfig(
        (await ctx.banksClient.getAccount(configPda()))!.data,
      );
      expect(cfg.cpmmAmmConfig.toBase58()).toBe(RAYDIUM_CPMM_AMM_CONFIG.toBase58());
      expect(cfg.graduatedFeeProtocolBps).toBe(2_000);
      expect(configLocksLiquidity(cfg)).toBe(false);

      // A stranger cannot touch it.
      const stranger = Keypair.generate();
      expect(
        await sendExpectFail(
          ctx,
          [
            cu(),
            buildSetGraduationConfigIx({
              authority: stranger.publicKey,
              ammConfig: RAYDIUM_CPMM_AMM_CONFIG,
              lockProgram: PublicKey.default,
              graduatedFeeProtocolBps: 0,
            }),
          ],
          [stranger],
        ),
      ).toMatch(/Unauthorized|ConstraintHasOne|2001|custom program error/i);

      // And the fee tier must be an account Raydium owns — this is what
      // stops a compromised authority pointing the migration at a config
      // some other program controls.
      expect(
        await sendExpectFail(
          ctx,
          [
            cu(),
            buildSetGraduationConfigIx({
              authority: authority.publicKey,
              ammConfig: Keypair.generate().publicKey,
              lockProgram: PublicKey.default,
              graduatedFeeProtocolBps: 0,
            }),
          ],
          [authority],
        ),
      ).toMatch(/owner|Owner|InvalidCpmmAccount|custom program error/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses re-initialization of the config",
    async () => {
      const logs = await sendExpectFail(
        ctx,
        [
          cu(),
          initializeConfigIx({
            payer: ctx.payer.publicKey,
            authority: authority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            params: PUMP_CLASSIC,
          }),
        ],
        [authority],
      );
      expect(logs).toMatch(/already in use|custom program error/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses a fee outside the permitted band (INV-FEE-FLOOR / INV-FEE-CAP)",
    async () => {
      // A zero-fee path would make wash trading free — the Meteora
      // cliff_fee=0 finding. Both bounds are checked on one code path.
      const outOfBand: [number, number][] = [
        [0, 0],
        [5, 4],
        [600, 0],
      ];
      for (const [protocol, creator] of outOfBand) {
        const params: CurveParams = {
          ...PUMP_CLASSIC,
          protocolFeeBps: protocol,
          creatorFeeBps: creator,
        };
        expect(
          await sendExpectFail(
            ctx,
            [cu(), updateConfigIx({ authority: authority.publicKey, params })],
            [authority],
          ),
        ).toMatch(/permitted range|custom program error/i);
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses curve params that could not fund their own graduation",
    async () => {
      // INV-GRAD-COVERS-COST: a curve that completes and then cannot afford
      // to migrate would strand every holder's SOL.
      const params: CurveParams = {
        ...PUMP_CLASSIC,
        initialVirtualSol: 100_000_000n, // raises ~0.28 SOL
      };
      expect(
        await sendExpectFail(
          ctx,
          [cu(), updateConfigIx({ authority: authority.publicKey, params })],
          [authority],
        ),
      ).toMatch(/graduation|custom program error/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses a config update from anyone but the authority",
    async () => {
      const impostor = Keypair.generate();
      expect(
        await sendExpectFail(
          ctx,
          [
            cu(),
            updateConfigIx({
              authority: impostor.publicKey,
              params: PUMP_CLASSIC,
            }),
          ],
          [impostor],
        ),
      ).toMatch(/unauthorized|constraint|custom program error/i);
    },
    TEST_TIMEOUT,
  );
});
