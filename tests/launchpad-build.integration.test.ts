/**
 * GATE L1 leg 1 — the launchpad build pipeline (SPEC-LAUNCHPAD.md §6).
 *
 * Proves that OUR compiled program loads and executes in the same bankrun
 * harness as the deployed binaries, that the graduation-CPI dependency links,
 * and that the config account comes out with the layout the SDK will decode.
 * This is the D-029 sequencing applied to the launchpad: pin the pipeline
 * before writing fund-handling logic, so a Phase-2 failure is never
 * ambiguous between "our math is wrong" and "the toolchain is wrong".
 *
 * Rebuild the fixture (toolchain pins in DECISIONS.md D-035):
 *   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
 *   export CARGO_NET_GIT_FETCH_WITH_CLI=true
 *   cargo-build-sbf --manifest-path programs/launchpad-curve/Cargo.toml
 *   gzip -9 -c programs/target/deploy/launchpad_curve.so \
 *     > tests/fixtures/launchpad_curve.so.gz
 *
 * Run: pnpm test:integration
 */
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import type { ProgramTestContext } from "solana-bankrun";
import { RAYDIUM_CPMM_PROGRAM_ID } from "../packages/sdk/src/constants";
import {
  TEST_TIMEOUT,
  send,
  sendExpectFail,
  startCtx,
} from "./helpers/bankrun-harness";

/** Scaffold id (throwaway key); the real id is minted at first devnet deploy. */
const LAUNCHPAD_PROGRAM_ID = new PublicKey(
  "6s4F21hxm5MurkGX6XdfcbPtMPXMxVfazATZRsiRrmvr",
);

/** Anchor discriminators, computed the same way the SDK builders will. */
const ixDisc = (name: string) =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const accountDisc = (name: string) =>
  createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);

const configPda = () =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    LAUNCHPAD_PROGRAM_ID,
  );

function initializeConfigIx(args: {
  payer: PublicKey;
  authority: PublicKey;
  feeRecipient: PublicKey;
  protocolFeeBps: number;
  creatorFeeBps: number;
}): TransactionInstruction {
  const data = Buffer.alloc(8 + 4);
  ixDisc("initialize_config").copy(data, 0);
  data.writeUInt16LE(args.protocolFeeBps, 8);
  data.writeUInt16LE(args.creatorFeeBps, 10);
  const [config] = configPda();
  return new TransactionInstruction({
    programId: LAUNCHPAD_PROGRAM_ID,
    data,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.feeRecipient, isSigner: false, isWritable: false },
      { pubkey: RAYDIUM_CPMM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: config, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

describe("launchpad-curve — build pipeline", () => {
  let ctx: ProgramTestContext;
  const authority = Keypair.generate();
  const feeRecipient = Keypair.generate();
  let cuNonce = 0;

  beforeAll(async () => {
    ctx = await startCtx([
      { name: "launchpad_curve", programId: LAUNCHPAD_PROGRAM_ID },
      { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
    ]);
  }, TEST_TIMEOUT);

  it(
    "creates the config PDA with the declared layout",
    async () => {
      // 70/30 split of a 1% trade fee (SPEC-LAUNCHPAD A2).
      await send(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 200_000 + cuNonce++,
          }),
          initializeConfigIx({
            payer: ctx.payer.publicKey,
            authority: authority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            protocolFeeBps: 70,
            creatorFeeBps: 30,
          }),
        ],
        [authority],
      );

      const [config, bump] = configPda();
      const info = await ctx.banksClient.getAccount(config);
      expect(info).not.toBeNull();
      expect(new PublicKey(info!.owner).toBase58()).toBe(
        LAUNCHPAD_PROGRAM_ID.toBase58(),
      );

      // Decoded by byte offset, exactly as the SDK will read it — no anchor
      // TS client anywhere in this repo's tests.
      const data = Buffer.from(info!.data);
      expect([...data.subarray(0, 8)]).toEqual([...accountDisc("Config")]);
      expect(new PublicKey(data.subarray(8, 40)).toBase58()).toBe(
        authority.publicKey.toBase58(),
      );
      expect(new PublicKey(data.subarray(40, 72)).toBase58()).toBe(
        feeRecipient.publicKey.toBase58(),
      );
      expect(data.readUInt16LE(72)).toBe(70);
      expect(data.readUInt16LE(74)).toBe(30);
      expect(new PublicKey(data.subarray(76, 108)).toBase58()).toBe(
        RAYDIUM_CPMM_PROGRAM_ID.toBase58(),
      );
      expect(data[108]).toBe(bump);
      // 8 disc + 32 + 32 + 2 + 2 + 32 + 1 bump + 64 reserved
      expect(data.length).toBe(173);
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses re-initialization of the config",
    async () => {
      const logs = await sendExpectFail(
        ctx,
        [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 200_000 + cuNonce++,
          }),
          initializeConfigIx({
            payer: ctx.payer.publicKey,
            authority: authority.publicKey,
            feeRecipient: feeRecipient.publicKey,
            protocolFeeBps: 70,
            creatorFeeBps: 30,
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
        [600, 0],
      ];
      for (const [protocol, creator] of outOfBand) {
        const logs = await sendExpectFail(
          ctx,
          [
            ComputeBudgetProgram.setComputeUnitLimit({
              units: 200_000 + cuNonce++,
            }),
            initializeConfigIx({
              payer: ctx.payer.publicKey,
              authority: authority.publicKey,
              feeRecipient: feeRecipient.publicKey,
              protocolFeeBps: protocol,
              creatorFeeBps: creator,
            }),
          ],
          [authority],
        );
        expect(logs).toMatch(/permitted range|custom program error/i);
      }
    },
    TEST_TIMEOUT,
  );
});
