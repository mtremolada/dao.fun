/**
 * proposal-gate client builders — Option A Guarded mode (spec 6.9,
 * D-033). On a guarded realm the gate PDA is the ONLY possible proposal
 * author (the community creation threshold is welded to u64::MAX and the
 * gate holds H+1 council tokens against minCouncil = H+1), so every
 * proposal flows through these instructions:
 *
 *   guardCreateProposal  -> CPI CreateProposal (gate council TOR owner,
 *                           community-voted, single-choice Approve/Deny)
 *   guardInsertTransaction -> validates the EXACT forwarded bytes against
 *                           the whitelist while guarded, CPI InsertTransaction
 *   guardSignOff / guardCancel -> requester-gated pass-through CPIs
 *
 * buildGateProposeIxs mirrors buildProposeIxs (ExecutionAdapter wrapping,
 * D-017 descriptionLink == inner-set hash, per-transaction hold-up) on
 * top of the gate. Buffered Squads chains are REFUSED by the gate by
 * design (cannot be validated from one account), so this builder throws
 * where buildProposeIxs would switch to the buffered wrap.
 */
import { createHash } from "node:crypto";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getProposalTransactionAddress } from "@solana/spl-governance";
import {
  GATE_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
} from "./constants";
import { computeInstructionSetHash } from "./artifact-hash";
import { unwrap, wrap, type WrapContext } from "./execution-adapter";

const PROGRAM_VERSION = 3;
/** Same plain-wrap budget as buildProposeIxs; above it the Squads chain
 * goes buffered, which the gate refuses — guarded proposals must fit. */
const PLAIN_CREATE_DATA_BUDGET = 500;

function disc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function str(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32LE(b.length);
  b.copy(out, 4);
  return out;
}

// ---------- PDA derivations ----------

export function deriveGate(realm: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("gate"), realm.toBuffer()],
    GATE_PROGRAM_ID,
  )[0];
}

export function deriveProposalMeta(proposal: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("meta"), proposal.toBuffer()],
    GATE_PROGRAM_ID,
  )[0];
}

export function deriveClearance(proposalTransaction: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("clearance"), proposalTransaction.toBuffer()],
    GATE_PROGRAM_ID,
  )[0];
}

/** The gate's council TokenOwnerRecord (proposal-creation seat). */
export function deriveGateTor(
  realm: PublicKey,
  councilMint: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("governance"),
      realm.toBuffer(),
      councilMint.toBuffer(),
      deriveGate(realm).toBuffer(),
    ],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

function deriveRealmConfig(realm: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("realm-config"), realm.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

function deriveProposal(
  governance: PublicKey,
  communityMint: PublicKey,
  proposalSeed: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("governance"),
      governance.toBuffer(),
      communityMint.toBuffer(),
      proposalSeed.toBuffer(),
    ],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

function deriveProposalDeposit(
  proposal: PublicKey,
  payer: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal-deposit"), proposal.toBuffer(), payer.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

function deriveHolding(realm: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("governance"), realm.toBuffer(), mint.toBuffer()],
    SPL_GOVERNANCE_PROGRAM_ID,
  )[0];
}

// ---------- guarded veto arithmetic ----------
// Lives in matrix.ts (chain-dep-free, browser-bundleable); re-exported
// here so gate consumers keep one import surface.
export { gateSeatCouncilTokens, guardedVetoPercent } from "./matrix";

// ---------- InstructionData serialization ----------

/**
 * borsh Vec<InstructionData> exactly as spl-governance stores it (and as
 * the gate's on-chain Reader parses it): count u32; per instruction
 * programId 32 + accounts u32x(32+1+1) + data u32+n.
 */
export function serializeInstructionSet(
  ixs: TransactionInstruction[],
): Buffer {
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
      parts.push(
        k.pubkey.toBuffer(),
        Buffer.from([k.isSigner ? 1 : 0, k.isWritable ? 1 : 0]),
      );
    }
    const dataLen = Buffer.alloc(4);
    dataLen.writeUInt32LE(ix.data.length);
    parts.push(dataLen, Buffer.from(ix.data));
  }
  return Buffer.concat(parts);
}

// ---------- instruction builders ----------

export interface GateConfigParams {
  realm: PublicKey;
  governance: PublicKey;
  communityMint: PublicKey;
  councilMint: PublicKey;
  /** Community holdings a requester must show to author via the gate. */
  proposalThresholdTokens: bigint;
  /** 0 guarded / 1 council / 2 cypherpunk / 3 sovereign. */
  mode: number;
  whitelist: PublicKey[];
  payer: PublicKey;
}

export function buildGateInitializeIx(
  p: GateConfigParams,
): TransactionInstruction {
  const threshold = Buffer.alloc(8);
  threshold.writeBigUInt64LE(p.proposalThresholdTokens);
  const vec = Buffer.alloc(4);
  vec.writeUInt32LE(p.whitelist.length);
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: deriveGate(p.realm), isSigner: false, isWritable: true },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("initialize"),
      p.realm.toBuffer(),
      p.governance.toBuffer(),
      p.communityMint.toBuffer(),
      p.councilMint.toBuffer(),
      threshold,
      Buffer.from([p.mode]),
      vec,
      ...p.whitelist.map((k) => k.toBuffer()),
    ]),
  });
}

/** Ceremony step: the gate deposits its H+1 council tokens into its TOR. */
export function buildDepositCouncilIx(p: {
  realm: PublicKey;
  councilMint: PublicKey;
  payer: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  const gate = deriveGate(p.realm);
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(p.amount);
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: gate, isSigner: false, isWritable: false },
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.realm, isSigner: false, isWritable: false },
      {
        pubkey: deriveHolding(p.realm, p.councilMint),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: getAssociatedTokenAddressSync(p.councilMint, gate, true),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveGateTor(p.realm, p.councilMint),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: deriveRealmConfig(p.realm),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SPL_GOVERNANCE_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc("deposit_council"), amount]),
  });
}

export interface GateRealmRefs {
  realm: PublicKey;
  governance: PublicKey;
  communityMint: PublicKey;
  councilMint: PublicKey;
}

export function buildGateCreateProposalIx(p: {
  refs: GateRealmRefs;
  requester: PublicKey;
  /** Defaults to the requester's community ATA. */
  requesterTokenAccount?: PublicKey;
  name: string;
  descriptionLink: string;
  proposalSeed: PublicKey;
}): { ix: TransactionInstruction; proposal: PublicKey } {
  const proposal = deriveProposal(
    p.refs.governance,
    p.refs.communityMint,
    p.proposalSeed,
  );
  const ix = new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      {
        pubkey: deriveGate(p.refs.realm),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: p.requester, isSigner: true, isWritable: true },
      {
        pubkey:
          p.requesterTokenAccount ??
          getAssociatedTokenAddressSync(p.refs.communityMint, p.requester),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: deriveProposalMeta(proposal),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.refs.realm, isSigner: false, isWritable: false },
      { pubkey: proposal, isSigner: false, isWritable: true },
      { pubkey: p.refs.governance, isSigner: false, isWritable: true },
      {
        pubkey: deriveGateTor(p.refs.realm, p.refs.councilMint),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: p.refs.communityMint, isSigner: false, isWritable: false },
      {
        pubkey: deriveRealmConfig(p.refs.realm),
        isSigner: false,
        isWritable: false,
      },
      {
        pubkey: deriveProposalDeposit(proposal, p.requester),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SPL_GOVERNANCE_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("guard_create_proposal"),
      str(p.name),
      str(p.descriptionLink),
      p.proposalSeed.toBuffer(),
    ]),
  });
  return { ix, proposal };
}

export async function buildGateInsertTransactionIx(p: {
  refs: GateRealmRefs;
  requester: PublicKey;
  proposal: PublicKey;
  index: number;
  holdUpSeconds: number;
  instruction: TransactionInstruction;
}): Promise<TransactionInstruction> {
  const ixBytes = serializeInstructionSet([p.instruction]);
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(ixBytes.length);
  const index = Buffer.alloc(2);
  index.writeUInt16LE(p.index);
  const holdUp = Buffer.alloc(4);
  holdUp.writeUInt32LE(p.holdUpSeconds);
  const proposalTransaction = await getProposalTransactionAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    p.proposal,
    0,
    p.index,
  );
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      {
        pubkey: deriveGate(p.refs.realm),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: p.requester, isSigner: true, isWritable: true },
      {
        pubkey: deriveProposalMeta(p.proposal),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: p.proposal, isSigner: false, isWritable: true },
      { pubkey: p.refs.governance, isSigner: false, isWritable: false },
      {
        pubkey: deriveGateTor(p.refs.realm, p.refs.councilMint),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: proposalTransaction, isSigner: false, isWritable: true },
      {
        pubkey: SPL_GOVERNANCE_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("guard_insert_transaction"),
      index,
      holdUp,
      lenPrefix,
      ixBytes,
    ]),
  });
}

function proposalActionIx(
  name: "guard_sign_off" | "guard_cancel",
  p: { refs: GateRealmRefs; requester: PublicKey; proposal: PublicKey },
): TransactionInstruction {
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      {
        pubkey: deriveGate(p.refs.realm),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: p.requester, isSigner: true, isWritable: false },
      {
        pubkey: deriveProposalMeta(p.proposal),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: p.refs.realm, isSigner: false, isWritable: true },
      { pubkey: p.refs.governance, isSigner: false, isWritable: true },
      { pubkey: p.proposal, isSigner: false, isWritable: true },
      {
        pubkey: deriveGateTor(p.refs.realm, p.refs.councilMint),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: SPL_GOVERNANCE_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: disc(name),
  });
}

export function buildGateSignOffIx(p: {
  refs: GateRealmRefs;
  requester: PublicKey;
  proposal: PublicKey;
}): TransactionInstruction {
  return proposalActionIx("guard_sign_off", p);
}

export function buildGateCancelIx(p: {
  refs: GateRealmRefs;
  requester: PublicKey;
  proposal: PublicKey;
}): TransactionInstruction {
  return proposalActionIx("guard_cancel", p);
}

/** Permissionless once the mode has ratcheted out of guarded. */
export function buildReleaseRealmAuthorityIx(p: {
  realm: PublicKey;
  governance: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: deriveGate(p.realm), isSigner: false, isWritable: false },
      { pubkey: p.realm, isSigner: false, isWritable: true },
      { pubkey: p.governance, isSigner: false, isWritable: false },
      {
        pubkey: SPL_GOVERNANCE_PROGRAM_ID,
        isSigner: false,
        isWritable: false,
      },
    ],
    data: disc("release_realm_authority"),
  });
}

/** Voted INV-11 ratchet leg (direct leg: the governance PDA signs). */
export function buildRatchetIx(p: {
  realm: PublicKey;
  governance: PublicKey;
  newMode: number;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: GATE_PROGRAM_ID,
    keys: [
      { pubkey: deriveGate(p.realm), isSigner: false, isWritable: true },
      { pubkey: p.governance, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc("ratchet"), Buffer.from([p.newMode])]),
  });
}

// ---------- the propose builder (gate flavor) ----------

export interface GateProposeParams {
  refs: GateRealmRefs;
  /** Signs everything and pays all rent; must hold the gate threshold. */
  requester: PublicKey;
  requesterTokenAccount?: PublicKey;
  name: string;
  innerIxs: TransactionInstruction[];
  /** Direct legs (D-022) appended after the custody chain. */
  directIxs?: TransactionInstruction[];
  wrapCtx: WrapContext;
  holdUpSeconds: number;
}

export interface GateProposeResult {
  proposal: PublicKey;
  proposalSeed: PublicKey;
  innerInstructionSetHash: string;
  wrapped: TransactionInstruction[];
  ptAddrs: PublicKey[];
  groups: {
    create: TransactionInstruction[];
    inserts: TransactionInstruction[][];
    signOff: TransactionInstruction[];
  };
}

export async function buildGateProposeIxs(
  p: GateProposeParams,
): Promise<GateProposeResult> {
  const directIxs = p.directIxs ?? [];
  if (p.innerIxs.length === 0 && directIxs.length === 0) {
    throw new Error("buildGateProposeIxs: inner instruction set is empty");
  }
  let chain: TransactionInstruction[] = [];
  if (p.innerIxs.length > 0) {
    chain = wrap(p.innerIxs, p.wrapCtx);
    if (chain[0]!.data.length > PLAIN_CREATE_DATA_BUDGET) {
      // the gate refuses buffered Squads chains BY DESIGN (a buffered
      // message spans accounts the validator cannot see) — fail loudly
      // here instead of building a proposal that can never insert.
      throw new Error(
        "buildGateProposeIxs: inner set too large for the plain wrap; guarded proposals must fit it",
      );
    }
  }
  const wrapped = [...chain, ...directIxs];
  const innerInstructionSetHash = computeInstructionSetHash([
    ...(chain.length > 0 ? unwrap(chain, p.wrapCtx) : []),
    ...directIxs,
  ]);

  const proposalSeed = Keypair.generate().publicKey;
  const { ix: createIx, proposal } = buildGateCreateProposalIx({
    refs: p.refs,
    requester: p.requester,
    ...(p.requesterTokenAccount
      ? { requesterTokenAccount: p.requesterTokenAccount }
      : {}),
    name: p.name,
    descriptionLink: innerInstructionSetHash, // D-017
    proposalSeed,
  });

  const inserts: TransactionInstruction[][] = [];
  const ptAddrs: PublicKey[] = [];
  for (const [i, ix] of wrapped.entries()) {
    inserts.push([
      await buildGateInsertTransactionIx({
        refs: p.refs,
        requester: p.requester,
        proposal,
        index: i,
        holdUpSeconds: p.holdUpSeconds,
        instruction: ix,
      }),
    ]);
    ptAddrs.push(
      await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        proposal,
        0,
        i,
      ),
    );
  }

  return {
    proposal,
    proposalSeed,
    innerInstructionSetHash,
    wrapped,
    ptAddrs,
    groups: {
      create: [createIx],
      inserts,
      signOff: [
        buildGateSignOffIx({ refs: p.refs, requester: p.requester, proposal }),
      ],
    },
  };
}
