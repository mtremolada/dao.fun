/**
 * proposal-gate builders — the guarded front door (D-042 / gate v2).
 *
 * Browser-safe (web3.js + sha256 only). Every PDA derivation and wire
 * format here is proven against the REAL deployed binaries by
 * tests/guarded-gate-v2.integration.test.ts, which drives THESE builders
 * in bankrun — the suite and the SDK cannot drift.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
  PROPOSAL_GATE_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
} from "./constants";
import { ixDiscriminator } from "./launchpad/constants";

const RENT_SYSVAR = new PublicKey("SysvarRent111111111111111111111111111111111");

/** Gate mode encoding (INV-11 ratchet order). */
export const GATE_MODE_GUARDED = 0;

/**
 * The default menu ("good defaults"): the entire 6.8 action surface —
 * grants/transfers (system), token ops + ATAs, setParam (governance),
 * the Squads custody chain, buyback/LP on the pump programs, and
 * distribute on the immutable merkle distributor. 8 of the 16 slots.
 */
export const DEFAULT_GATE_WHITELIST: PublicKey[] = [
  SystemProgram.programId,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
];

const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const gatePda = (realm: PublicKey, programId = PROPOSAL_GATE_PROGRAM_ID) =>
  pda([Buffer.from("gate"), realm.toBuffer()], programId);

/** Owner of the realm's single council token; signs only via the program. */
export const gateAuthorityPda = (realm: PublicKey, programId = PROPOSAL_GATE_PROGRAM_ID) =>
  pda([Buffer.from("gate-authority"), realm.toBuffer()], programId);

// -- spl-governance PDAs (sync mirrors of the client helpers; equality with
// -- the async client derivations is pinned in the sdk unit suite).
export const governingTokenHoldingPda = (realm: PublicKey, mint: PublicKey) =>
  pda([Buffer.from("governance"), realm.toBuffer(), mint.toBuffer()], SPL_GOVERNANCE_PROGRAM_ID);
export const realmConfigPda = (realm: PublicKey) =>
  pda([Buffer.from("realm-config"), realm.toBuffer()], SPL_GOVERNANCE_PROGRAM_ID);
export const tokenOwnerRecordPda = (realm: PublicKey, mint: PublicKey, owner: PublicKey) =>
  pda(
    [Buffer.from("governance"), realm.toBuffer(), mint.toBuffer(), owner.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  );
export const gatedProposalPda = (
  governance: PublicKey,
  communityMint: PublicKey,
  proposalSeed: PublicKey,
) =>
  pda(
    [Buffer.from("governance"), governance.toBuffer(), communityMint.toBuffer(), proposalSeed.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  );
export const proposalDepositPda = (proposal: PublicKey, payer: PublicKey) =>
  pda(
    [Buffer.from("proposal-deposit"), proposal.toBuffer(), payer.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  );
export const proposalTransactionPda = (
  proposal: PublicKey,
  optionIndex: number,
  index: number,
) => {
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(index);
  return pda(
    [Buffer.from("governance"), proposal.toBuffer(), Buffer.from([optionIndex]), idx],
    SPL_GOVERNANCE_PROGRAM_ID,
  );
};

const AM = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({
  pubkey,
  isSigner,
  isWritable,
});
const borshStr = (s: string) => {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/** Borsh Vec<InstructionData> — exactly what the gate validates + inserts. */
export function serializeInstructionSet(ixs: TransactionInstruction[]): Buffer {
  const parts: Buffer[] = [];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(ixs.length);
  parts.push(count);
  for (const ix of ixs) {
    parts.push(ix.programId.toBuffer());
    const metaCount = Buffer.alloc(4);
    metaCount.writeUInt32LE(ix.keys.length);
    parts.push(metaCount);
    for (const k of ix.keys) {
      parts.push(k.pubkey.toBuffer(), Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]));
    }
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(ix.data.length);
    parts.push(dataLen, Buffer.from(ix.data));
  }
  return Buffer.concat(parts);
}

export function buildGateInitializeIx(args: {
  payer: PublicKey;
  realm: PublicKey;
  governance: PublicKey;
  communityMint: PublicKey;
  councilMint: PublicKey;
  mode?: number;
  whitelist?: PublicKey[];
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? PROPOSAL_GATE_PROGRAM_ID;
  const whitelist = args.whitelist ?? DEFAULT_GATE_WHITELIST;
  const vec = Buffer.alloc(4);
  vec.writeUInt32LE(whitelist.length);
  return new TransactionInstruction({
    programId,
    keys: [
      AM(gatePda(args.realm, programId), false, true),
      AM(args.payer, true, true),
      AM(SystemProgram.programId, false, false),
    ],
    data: Buffer.concat([
      ixDiscriminator("initialize"),
      args.realm.toBuffer(),
      args.governance.toBuffer(),
      args.communityMint.toBuffer(),
      args.councilMint.toBuffer(),
      Buffer.from([args.mode ?? GATE_MODE_GUARDED]),
      vec,
      ...whitelist.map((p) => p.toBuffer()),
    ]),
  });
}

/** Ceremony step: the gate deposits its single council token (PDA-signed). */
export function buildBindRealmIx(args: {
  payer: PublicKey;
  realm: PublicKey;
  councilMint: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? PROPOSAL_GATE_PROGRAM_ID;
  const authority = gateAuthorityPda(args.realm, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      AM(gatePda(args.realm, programId), false, false),
      AM(authority, false, false),
      AM(args.realm, false, false),
      AM(governingTokenHoldingPda(args.realm, args.councilMint), false, true),
      AM(getAssociatedTokenAddressSync(args.councilMint, authority, true), false, true),
      AM(tokenOwnerRecordPda(args.realm, args.councilMint, authority), false, true),
      AM(realmConfigPda(args.realm), false, true),
      AM(args.payer, true, true),
      AM(SystemProgram.programId, false, false),
      AM(TOKEN_PROGRAM_ID, false, false),
      AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(ixDiscriminator("bind_realm")),
  });
}

export function buildCreateGatedProposalIx(args: {
  proposer: PublicKey;
  realm: PublicKey;
  governance: PublicKey;
  communityMint: PublicKey;
  councilMint: PublicKey;
  name: string;
  descriptionLink: string;
  proposalSeed: PublicKey;
  programId?: PublicKey;
}): { ix: TransactionInstruction; proposal: PublicKey } {
  const programId = args.programId ?? PROPOSAL_GATE_PROGRAM_ID;
  const authority = gateAuthorityPda(args.realm, programId);
  const proposal = gatedProposalPda(args.governance, args.communityMint, args.proposalSeed);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      AM(gatePda(args.realm, programId), false, false),
      AM(authority, false, false),
      AM(args.realm, false, false),
      AM(proposal, false, true),
      AM(args.governance, false, true),
      AM(tokenOwnerRecordPda(args.realm, args.councilMint, authority), false, true),
      AM(args.communityMint, false, false),
      AM(realmConfigPda(args.realm), false, false),
      AM(proposalDepositPda(proposal, args.proposer), false, true),
      AM(args.proposer, true, true),
      AM(SystemProgram.programId, false, false),
      AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([
      ixDiscriminator("create_gated_proposal"),
      borshStr(args.name),
      borshStr(args.descriptionLink),
      args.proposalSeed.toBuffer(),
    ]),
  });
  return { ix, proposal };
}

export function buildInsertGatedTransactionIx(args: {
  proposer: PublicKey;
  realm: PublicKey;
  governance: PublicKey;
  councilMint: PublicKey;
  proposal: PublicKey;
  optionIndex?: number;
  index: number;
  holdUpSeconds: number;
  instructions: TransactionInstruction[];
  programId?: PublicKey;
}): { ix: TransactionInstruction; proposalTransaction: PublicKey } {
  const programId = args.programId ?? PROPOSAL_GATE_PROGRAM_ID;
  const authority = gateAuthorityPda(args.realm, programId);
  const optionIndex = args.optionIndex ?? 0;
  const proposalTransaction = proposalTransactionPda(args.proposal, optionIndex, args.index);
  const idx = Buffer.alloc(2);
  idx.writeUInt16LE(args.index);
  const holdUp = Buffer.alloc(4);
  holdUp.writeUInt32LE(args.holdUpSeconds);
  const ix = new TransactionInstruction({
    programId,
    keys: [
      AM(gatePda(args.realm, programId), false, false),
      AM(authority, false, false),
      AM(args.governance, false, false),
      AM(args.proposal, false, true),
      AM(tokenOwnerRecordPda(args.realm, args.councilMint, authority), false, false),
      AM(proposalTransaction, false, true),
      AM(args.proposer, true, true),
      AM(SystemProgram.programId, false, false),
      AM(RENT_SYSVAR, false, false),
      AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
    ],
    data: Buffer.concat([
      ixDiscriminator("insert_gated_transaction"),
      Buffer.from([optionIndex]),
      idx,
      holdUp,
      serializeInstructionSet(args.instructions),
    ]),
  });
  return { ix, proposalTransaction };
}

export function buildSignOffGatedProposalIx(args: {
  realm: PublicKey;
  governance: PublicKey;
  councilMint: PublicKey;
  proposal: PublicKey;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = args.programId ?? PROPOSAL_GATE_PROGRAM_ID;
  const authority = gateAuthorityPda(args.realm, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      AM(gatePda(args.realm, programId), false, false),
      AM(authority, false, false),
      AM(args.realm, false, true),
      AM(args.governance, false, true),
      AM(args.proposal, false, true),
      AM(tokenOwnerRecordPda(args.realm, args.councilMint, authority), false, false),
      AM(SPL_GOVERNANCE_PROGRAM_ID, false, false),
    ],
    data: Buffer.from(ixDiscriminator("sign_off_gated_proposal")),
  });
}
