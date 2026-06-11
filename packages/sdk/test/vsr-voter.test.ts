/**
 * VSR voter-side builders (createVoter / deposit / vote-weight / withdraw /
 * close) — written before implementation. Byte layouts and account orders
 * are pinned against the vendored IDL (src/idl/vsr.json) and the program
 * source (seeds verified 2026-06-11: voter = [registrar, "voter", authority],
 * voter-weight-record = [registrar, "voter-weight-record", authority];
 * LockupKind declaration order None/Daily/Monthly/Cliff/Constant).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { VSR_PROGRAM_ID } from "../src/constants";
import {
  LockupKind,
  buildCloseDepositEntryIx,
  buildCloseVoterIx,
  buildCreateDepositEntryIx,
  buildCreateVoterIx,
  buildDepositIx,
  buildUpdateVoterWeightRecordIx,
  buildWithdrawIx,
  deriveVsrVoter,
  deriveVsrVoterWeightRecord,
} from "../src/vsr";

const registrar = Keypair.generate().publicKey;
const authority = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

describe("voter PDA derivations (source-verified seeds)", () => {
  it("voter and voter-weight-record derive with registrar-first seeds", () => {
    const [expVoter, voterBump] = PublicKey.findProgramAddressSync(
      [registrar.toBuffer(), Buffer.from("voter"), authority.toBuffer()],
      VSR_PROGRAM_ID,
    );
    const [expVwr, vwrBump] = PublicKey.findProgramAddressSync(
      [
        registrar.toBuffer(),
        Buffer.from("voter-weight-record"),
        authority.toBuffer(),
      ],
      VSR_PROGRAM_ID,
    );
    const voter = deriveVsrVoter(registrar, authority);
    const vwr = deriveVsrVoterWeightRecord(registrar, authority);
    expect(voter.address.equals(expVoter)).toBe(true);
    expect(voter.bump).toBe(voterBump);
    expect(vwr.address.equals(expVwr)).toBe(true);
    expect(vwr.bump).toBe(vwrBump);
  });
});

describe("createVoter", () => {
  const { ix } = buildCreateVoterIx({ registrar, voterAuthority: authority, payer });

  it("matches the IDL account order and signer/writable flags", () => {
    const voter = deriveVsrVoter(registrar, authority);
    const vwr = deriveVsrVoterWeightRecord(registrar, authority);
    const keys = ix.keys;
    expect(ix.programId.equals(VSR_PROGRAM_ID)).toBe(true);
    expect(keys.map((k) => k.pubkey.toBase58())).toEqual(
      [
        registrar,
        voter.address,
        authority,
        vwr.address,
        payer,
        SystemProgram.programId,
        SYSVAR_RENT_PUBKEY,
        SYSVAR_INSTRUCTIONS_PUBKEY,
      ].map((k) => k.toBase58()),
    );
    expect(keys[1]!.isWritable).toBe(true); // voter
    expect(keys[2]!.isSigner).toBe(true); // voterAuthority
    expect(keys[3]!.isWritable).toBe(true); // voterWeightRecord
    expect(keys[4]!.isSigner).toBe(true); // payer
    expect(keys[4]!.isWritable).toBe(true);
  });

  it("encodes discriminator + both bumps", () => {
    const voter = deriveVsrVoter(registrar, authority);
    const vwr = deriveVsrVoterWeightRecord(registrar, authority);
    expect(ix.data.subarray(0, 8).equals(disc("create_voter"))).toBe(true);
    expect(ix.data[8]).toBe(voter.bump);
    expect(ix.data[9]).toBe(vwr.bump);
    expect(ix.data.length).toBe(10);
  });
});

describe("createDepositEntry", () => {
  it("derives the vault as the voter's ATA under the given token program", () => {
    const voter = deriveVsrVoter(registrar, authority).address;
    const { ix, vault } = buildCreateDepositEntryIx({
      registrar,
      voterAuthority: authority,
      payer,
      depositMint: mint,
      depositEntryIndex: 0,
      kind: LockupKind.None,
      periods: 0,
      allowClawback: false,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    expect(
      vault.equals(getAssociatedTokenAddressSync(mint, voter, true, TOKEN_2022_PROGRAM_ID)),
    ).toBe(true);
    expect(ix.keys[7]!.pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
  });

  it("matches the IDL account order and encodes args (kind enum, Option<u64> startTs)", () => {
    const voter = deriveVsrVoter(registrar, authority).address;
    const { ix, vault } = buildCreateDepositEntryIx({
      registrar,
      voterAuthority: authority,
      payer,
      depositMint: mint,
      depositEntryIndex: 3,
      kind: LockupKind.Cliff,
      startTs: 1_700_000_000n,
      periods: 5,
      allowClawback: false,
    });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [
        registrar,
        voter,
        vault,
        authority,
        payer,
        mint,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SYSVAR_RENT_PUBKEY,
      ].map((k) => k.toBase58()),
    );
    const d = ix.data;
    expect(d.subarray(0, 8).equals(disc("create_deposit_entry"))).toBe(true);
    expect(d[8]).toBe(3); // depositEntryIndex
    expect(d[9]).toBe(3); // LockupKind.Cliff (None=0 Daily=1 Monthly=2 Cliff=3 Constant=4)
    expect(d[10]).toBe(1); // Option::Some
    expect(d.readBigUInt64LE(11)).toBe(1_700_000_000n);
    expect(d.readUInt32LE(19)).toBe(5); // periods
    expect(d[23]).toBe(0); // allowClawback
    expect(d.length).toBe(24);

    const none = buildCreateDepositEntryIx({
      registrar,
      voterAuthority: authority,
      payer,
      depositMint: mint,
      depositEntryIndex: 0,
      kind: LockupKind.None,
      periods: 0,
      allowClawback: false,
    });
    expect(none.ix.data[9]).toBe(0); // LockupKind.None
    expect(none.ix.data[10]).toBe(0); // Option::None
    expect(none.ix.data.readUInt32LE(11)).toBe(0);
    expect(none.ix.data.length).toBe(16);
  });
});

describe("deposit / withdraw", () => {
  const voter = deriveVsrVoter(registrar, authority).address;
  const vwr = deriveVsrVoterWeightRecord(registrar, authority).address;
  const vault = Keypair.generate().publicKey;
  const tokenAccount = Keypair.generate().publicKey;
  const tor = Keypair.generate().publicKey;

  it("deposit: [registrar, voter, vault, depositToken, depositAuthority(s), tokenProgram]", () => {
    const ix = buildDepositIx({
      registrar,
      voterAuthority: authority,
      vault,
      depositToken: tokenAccount,
      depositEntryIndex: 1,
      amount: 123_456n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [registrar, voter, vault, tokenAccount, authority, TOKEN_2022_PROGRAM_ID].map(
        (k) => k.toBase58(),
      ),
    );
    expect(ix.keys[4]!.isSigner).toBe(true);
    expect(ix.data.subarray(0, 8).equals(disc("deposit"))).toBe(true);
    expect(ix.data[8]).toBe(1);
    expect(ix.data.readBigUInt64LE(9)).toBe(123_456n);
  });

  it("withdraw: IDL order incl. tokenOwnerRecord and voterWeightRecord", () => {
    const destination = Keypair.generate().publicKey;
    const ix = buildWithdrawIx({
      registrar,
      voterAuthority: authority,
      tokenOwnerRecord: tor,
      vault,
      destination,
      depositEntryIndex: 1,
      amount: 99n,
    });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [registrar, voter, authority, tor, vwr, vault, destination, TOKEN_PROGRAM_ID].map(
        (k) => k.toBase58(),
      ),
    );
    expect(ix.keys[2]!.isSigner).toBe(true);
    expect(ix.data.subarray(0, 8).equals(disc("withdraw"))).toBe(true);
    expect(ix.data[8]).toBe(1);
    expect(ix.data.readBigUInt64LE(9)).toBe(99n);
  });
});

describe("updateVoterWeightRecord / close", () => {
  const voter = deriveVsrVoter(registrar, authority).address;
  const vwr = deriveVsrVoterWeightRecord(registrar, authority).address;

  it("updateVoterWeightRecord: [registrar, voter, vwr(w), system], no args", () => {
    const ix = buildUpdateVoterWeightRecordIx({ registrar, voterAuthority: authority });
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [registrar, voter, vwr, SystemProgram.programId].map((k) => k.toBase58()),
    );
    expect(ix.keys[2]!.isWritable).toBe(true);
    expect(ix.data.equals(disc("update_voter_weight_record"))).toBe(true);
  });

  it("closeDepositEntry and closeVoter return rent to the right places", () => {
    const close = buildCloseDepositEntryIx({
      registrar,
      voterAuthority: authority,
      depositEntryIndex: 2,
    });
    expect(close.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [voter, authority].map((k) => k.toBase58()),
    );
    expect(close.data.subarray(0, 8).equals(disc("close_deposit_entry"))).toBe(true);
    expect(close.data[8]).toBe(2);

    const dest = Keypair.generate().publicKey;
    const closeVoter = buildCloseVoterIx({
      registrar,
      voterAuthority: authority,
      solDestination: dest,
    });
    expect(closeVoter.keys.map((k) => k.pubkey.toBase58())).toEqual(
      [registrar, voter, authority, dest, TOKEN_PROGRAM_ID].map((k) => k.toBase58()),
    );
    expect(closeVoter.data.equals(disc("close_voter"))).toBe(true);
  });
});
