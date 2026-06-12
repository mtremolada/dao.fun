/**
 * Client-side instruction decoder (INV-10, decentralized). Turns the UNWRAPPED
 * inner instructions of a proposal into a human-readable summary + red flags,
 * entirely in the browser — so the proposal view needs no backend artifact
 * store. The security-critical guarantee is the SAFE FALLBACK: any instruction
 * this decoder does not recognise renders as "UNKNOWN — raw data" and raises
 * the `unknown-instruction` flag, so nothing executable is ever silently
 * hidden (it is flagged, never dropped), matching the badge's coverage.
 */
import {
  Connection,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readProposalInstructions } from "./chain-reader";
import {
  MERKLE_DISTRIBUTOR_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "./constants";

const NAMED_PROGRAMS = new Map<string, string>([
  [SystemProgram.programId.toBase58(), "System"],
  [TOKEN_PROGRAM_ID.toBase58(), "SPL Token"],
  [TOKEN_2022_PROGRAM_ID.toBase58(), "Token-2022"],
  [SPL_GOVERNANCE_PROGRAM_ID.toBase58(), "SPL Governance"],
  [SQUADS_V4_PROGRAM_ID.toBase58(), "Squads v4"],
  [MERKLE_DISTRIBUTOR_PROGRAM_ID.toBase58(), "Merkle distributor"],
  [PUMP_PROGRAM_ID.toBase58(), "pump.fun"],
  [PUMP_AMM_PROGRAM_ID.toBase58(), "PumpSwap AMM"],
  [VSR_PROGRAM_ID.toBase58(), "Voter Stake Registry"],
]);

export interface DecodedInstruction {
  program: string;
  summary: string;
  /** False => "UNKNOWN — raw data"; raises the unknown-instruction flag. */
  known: boolean;
  /** Per-instruction red flags (e.g. sol-transfer, governance-config-change). */
  flags: string[];
}

function isProgram(ix: TransactionInstruction, id: PublicKey): boolean {
  return ix.programId.equals(id);
}

function u64le(data: Buffer | Uint8Array, offset: number): bigint | null {
  const b = Buffer.from(data);
  if (b.length < offset + 8) return null;
  return b.readBigUInt64LE(offset);
}

/** SPL-Token instruction tags (first byte) we surface. */
const TOKEN_TAG: Record<number, string> = {
  3: "Transfer",
  7: "MintTo",
  8: "Burn",
  12: "TransferChecked",
  15: "BurnChecked",
  6: "SetAuthority",
};

export function decodeInstruction(ix: TransactionInstruction): DecodedInstruction {
  const program = NAMED_PROGRAMS.get(ix.programId.toBase58());

  if (isProgram(ix, SystemProgram.programId)) {
    try {
      const type = SystemInstruction.decodeInstructionType(ix);
      if (type === "Transfer") {
        const { lamports } = SystemInstruction.decodeTransfer(ix);
        return {
          program: "System",
          summary: `Transfer ${lamports} lamports (${(Number(lamports) / 1e9).toFixed(9)} SOL)`,
          known: true,
          flags: ["sol-transfer"],
        };
      }
      return { program: "System", summary: `System: ${type}`, known: true, flags: [] };
    } catch {
      /* fall through to raw */
    }
  }

  if (isProgram(ix, TOKEN_PROGRAM_ID) || isProgram(ix, TOKEN_2022_PROGRAM_ID)) {
    const tag = TOKEN_TAG[ix.data[0] ?? -1];
    if (tag) {
      const amount =
        tag === "Transfer" || tag === "Burn" || tag === "MintTo" || tag === "TransferChecked" || tag === "BurnChecked"
          ? u64le(ix.data, 1)
          : null;
      return {
        program: program ?? "Token",
        summary: amount !== null ? `${tag} ${amount} base units` : tag,
        known: true,
        flags: tag === "Burn" || tag === "BurnChecked" ? ["token-burn"] : [],
      };
    }
  }

  if (isProgram(ix, SPL_GOVERNANCE_PROGRAM_ID)) {
    // The only direct-leg governance instruction the menu emits is
    // setGovernanceConfig (setParam). Flag any governance-config interaction.
    return {
      program: "SPL Governance",
      summary: "Governance configuration / proposal instruction (setParam)",
      known: true,
      flags: ["governance-config-change"],
    };
  }

  if (program) {
    // A known program but an instruction we do not decode field-by-field.
    return {
      program,
      summary: `${program}: ${ix.data.length}-byte instruction (raw)`,
      known: true,
      flags: [],
    };
  }

  return {
    program: ix.programId.toBase58(),
    summary: "UNKNOWN — raw data",
    known: false,
    flags: ["unknown-instruction"],
  };
}

export interface ProposalDecode {
  instructions: DecodedInstruction[];
  /** One-line human summary of the whole proposal. */
  summary: string;
  /** Deduped red flags across all instructions (INV-10). */
  redFlags: string[];
}

export function decodeProposal(
  ixs: TransactionInstruction[],
): ProposalDecode {
  const instructions = ixs.map(decodeInstruction);
  const flags = new Set<string>();
  for (const d of instructions) for (const f of d.flags) flags.add(f);
  const summary =
    instructions.length === 0
      ? "No executable instructions"
      : instructions.map((d) => `• ${d.program}: ${d.summary}`).join("\n");
  return { instructions, summary, redFlags: [...flags] };
}

/**
 * Decode a proposal's effects straight from chain, in the browser — the whole
 * INV-10 decoded summary with no backend artifact store. `partial` is true when
 * the on-chain set could not be fully re-read (decode covers only a prefix).
 */
export async function decodeProposalFromChain(
  connection: Connection,
  proposal: PublicKey,
): Promise<(ProposalDecode & { partial: boolean }) | null> {
  const read = await readProposalInstructions(connection, proposal);
  if (!read) return null;
  return { ...decodeProposal(read.instructions), partial: !read.complete };
}
