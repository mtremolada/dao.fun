/**
 * Dump the deployed mainnet program binaries the GATE 1 integration suite
 * runs against (solana-bankrun loads them locally), plus the Squads
 * ProgramConfig account it reads at multisig creation. Read-only; public
 * RPC. Idempotent — skips fixtures that already exist unless --force.
 *
 *   npx tsx scripts/dump-mainnet-programs.ts
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
  VSR_PROGRAM_ID,
} from "../packages/sdk/src/constants";

const RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const OUT = "tests/fixtures";
const FORCE = process.argv.includes("--force");

// BPF upgradeable loader layout: ProgramData = 4 (enum) + 8 (slot) +
// 1+32 (option<upgrade authority>) header, then the ELF.
const PROGRAMDATA_HEADER = 45;

const PROGRAMS: { name: string; id: PublicKey }[] = [
  { name: "spl_governance", id: SPL_GOVERNANCE_PROGRAM_ID },
  { name: "squads_v4", id: SQUADS_V4_PROGRAM_ID },
  { name: "vsr", id: VSR_PROGRAM_ID },
  // bankrun's program-test preloads classic SPL Token but NOT Token-2022.
  { name: "token_2022", id: TOKEN_2022_PROGRAM_ID },
];

async function dumpProgram(connection: Connection, name: string, id: PublicKey) {
  const out = join(OUT, `${name}.so`);
  if (existsSync(out) && !FORCE) {
    console.log(`${out} exists, skipping`);
    return;
  }
  const program = await connection.getAccountInfo(id);
  if (!program) throw new Error(`${name}: program account missing`);
  // Upgradeable program account data: 4-byte enum + programdata address.
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await connection.getAccountInfo(programData);
  if (!pd) throw new Error(`${name}: programdata missing`);
  const elf = pd.data.subarray(PROGRAMDATA_HEADER);
  writeFileSync(out, elf);
  console.log(`${out}: ${elf.length} bytes (programdata ${programData.toBase58()})`);
}

async function dumpSquadsProgramConfig(connection: Connection) {
  const out = join(OUT, "squads-program-config.json");
  if (existsSync(out) && !FORCE) {
    console.log(`${out} exists, skipping`);
    return;
  }
  const [pda] = multisig.getProgramConfigPda({});
  const info = await connection.getAccountInfo(pda);
  if (!info) throw new Error("squads ProgramConfig missing");
  const [config] = multisig.accounts.ProgramConfig.fromAccountInfo(info);
  writeFileSync(
    out,
    JSON.stringify(
      {
        address: pda.toBase58(),
        owner: info.owner.toBase58(),
        lamports: info.lamports,
        treasury: config.treasury.toBase58(),
        multisigCreationFee: config.multisigCreationFee.toString(),
        dataBase64: info.data.toString("base64"),
      },
      null,
      2,
    ),
  );
  console.log(`${out}: treasury ${config.treasury.toBase58()}`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const connection = new Connection(RPC, "confirmed");
  for (const p of PROGRAMS) await dumpProgram(connection, p.name, p.id);
  await dumpSquadsProgramConfig(connection);
}

void main();
