/**
 * Dump the deployed mainnet program binaries the GATE 1 integration suite
 * runs against (solana-bankrun loads them locally), plus the Squads
 * ProgramConfig account it reads at multisig creation. Read-only; public
 * RPC. Idempotent — skips fixtures that already exist unless --force.
 *
 *   npx tsx scripts/dump-mainnet-programs.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA,
  FEE_PROGRAM_GLOBAL_PDA,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  PUMP_FEE_CONFIG_PDA,
  getGlobalParamsPda,
  getSolVaultPda,
} from "@pump-fun/pump-sdk";
import {
  GLOBAL_CONFIG_PDA as AMM_GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
} from "@pump-fun/pump-swap-sdk";
import * as multisig from "@sqds/multisig";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
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
  // The pump stack (GATE 0c experiments).
  { name: "pump", id: PUMP_PROGRAM_ID },
  { name: "pump_fees", id: PUMP_FEES_PROGRAM_ID },
  { name: "pump_amm", id: PUMP_AMM_PROGRAM_ID },
];

// Live state accounts the pump stack reads (config/global PDAs).
const ACCOUNTS: { label: string; address: PublicKey }[] = [
  { label: "pump-global", address: GLOBAL_PDA },
  { label: "pump-fee-config", address: PUMP_FEE_CONFIG_PDA },
  { label: "fee-program-global", address: FEE_PROGRAM_GLOBAL_PDA },
  { label: "pump-global-volume-accumulator", address: GLOBAL_VOLUME_ACCUMULATOR_PDA },
  { label: "mayhem-global-params", address: getGlobalParamsPda() },
  { label: "mayhem-sol-vault", address: getSolVaultPda() },
  // PumpSwap AMM (post-graduation venue: migrate CPI + pool trades).
  { label: "amm-global-config", address: AMM_GLOBAL_CONFIG_PDA },
  { label: "amm-fee-config", address: PUMP_AMM_FEE_CONFIG_PDA },
  { label: "amm-global-volume-accumulator", address: AMM_GLOBAL_VOLUME_ACCUMULATOR_PDA },
];

async function dumpAccounts(connection: Connection) {
  const out = join(OUT, "pump-accounts.json");
  if (existsSync(out) && !FORCE) {
    // Top-up mode: only re-dump if a wanted label is missing from the file.
    const have = new Set(
      (JSON.parse(readFileSync(out, "utf8")) as { label: string }[]).map(
        (e) => e.label,
      ),
    );
    if (ACCOUNTS.every((a) => have.has(a.label))) {
      console.log(`${out} exists with all labels, skipping`);
      return;
    }
  }
  const entries = [];
  for (const { label, address } of ACCOUNTS) {
    const info = await connection.getAccountInfo(address);
    if (!info) {
      console.log(`${label} (${address.toBase58()}): missing on mainnet, skipped`);
      continue;
    }
    entries.push({
      label,
      address: address.toBase58(),
      owner: info.owner.toBase58(),
      lamports: info.lamports,
      dataBase64: info.data.toString("base64"),
    });
    console.log(`${label}: ${info.data.length} bytes`);
  }
  writeFileSync(out, JSON.stringify(entries, null, 2));
}

async function dumpProgram(connection: Connection, name: string, id: PublicKey) {
  // Committed gzipped (zero-padded 10 MB programdata compresses ~10x);
  // the test harness inflates to .so before bankrun loads it.
  const out = join(OUT, `${name}.so.gz`);
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
  const gz = gzipSync(elf, { level: 9 });
  writeFileSync(out, gz);
  console.log(
    `${out}: ${gz.length} bytes gz (elf ${elf.length}, programdata ${programData.toBase58()})`,
  );
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
  await dumpAccounts(connection);
}

void main();
