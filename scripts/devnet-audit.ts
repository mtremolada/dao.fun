/**
 * Devnet audit — read the LIVE state and check it against what the program,
 * the SDK and the docs claim. Read-only: it signs nothing and spends nothing,
 * so it is safe to run any time, and it is the thing to run before believing
 * a devnet gate.
 *
 * The point is not "does it print nicely" — it is that every invariant we
 * assert in bankrun is re-checked against real accounts a real deploy
 * produced. A test suite can only prove things about the binary it loads;
 * this proves the deployed binary was configured and driven correctly.
 *
 *   pnpm tsx scripts/devnet-audit.ts [--rpc <url>]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  configPda,
  creatorVaultPda,
  curvePda,
  decodeConfig,
  decodeCurve,
  decodeCpmmPool,
  graduatedFeesPda,
  protocolVaultPda,
} from "../packages/sdk/src/launchpad";
import {
  RAYDIUM_CPMM_AMM_CONFIG_1PCT_DEVNET,
  RAYDIUM_CPMM_PROGRAM_ID_DEVNET,
} from "../packages/sdk/src/constants";

const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const rpcArg = process.argv.indexOf("--rpc");
const RPC =
  rpcArg > -1 ? process.argv[rpcArg + 1]! : "https://api.devnet.solana.com";

/** Curve account length — the size filter that keeps Config out of the scan. */
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;

const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  console.log(`RPC ${RPC}\nprogram ${PROGRAM_ID.toBase58()}\n`);

  // ---- the program account itself ----
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  check(programInfo?.executable === true, "program account is executable");

  // Is the deployed binary the one this repo's tests actually load? Without
  // this, "the suite is green" and "the deploy is correct" are two unrelated
  // facts. Compare the PREFIX, not the whole account: `solana program deploy`
  // grows programdata with slack, so the deployed bytes are the ELF followed
  // by zero padding, and a naive whole-file hash mismatches for that reason
  // alone.
  const fixture = gunzipSync(
    readFileSync(resolve(__dirname, "../tests/fixtures/launchpad_curve.so.gz")),
  );
  const programData = new PublicKey(
    // BPFLoaderUpgradeable program account: 4-byte enum + 32-byte address.
    programInfo!.data.subarray(4, 36),
  );
  const pdInfo = await connection.getAccountInfo(programData);
  // ProgramData layout: 4 enum + 8 slot + 1 option + 32 authority = 45 bytes.
  const deployed = pdInfo!.data.subarray(45);
  const prefix = deployed.subarray(0, fixture.length);
  const padding = deployed.subarray(fixture.length);
  check(
    Buffer.from(prefix).equals(Buffer.from(fixture)),
    "deployed binary == tests/fixtures/launchpad_curve.so.gz",
    `${fixture.length} bytes`,
  );
  check(
    padding.every((b) => b === 0),
    "everything past the ELF is zero padding",
    `${padding.length} bytes`,
  );

  // ---- config ----
  const cfgPda = configPda(PROGRAM_ID);
  const cfgInfo = await connection.getAccountInfo(cfgPda);
  if (!cfgInfo) {
    console.log("no config account — the program is deployed but uninitialised");
    process.exit(1);
  }
  const cfg = decodeConfig(cfgInfo.data);
  console.log(`config ${cfgPda.toBase58()} (${cfgInfo.data.length} bytes)`);
  console.log(`  authority        ${cfg.authority.toBase58()}`);
  console.log(`  feeRecipient     ${cfg.feeRecipient.toBase58()}`);
  console.log(`  fees             protocol ${cfg.protocolFeeBps}bps / creator ${cfg.creatorFeeBps}bps`);
  console.log(`  graduationFee    ${SOL(cfg.graduationFeeLamports)} SOL`);
  console.log(`  cpmmProgram      ${cfg.cpmmProgram.toBase58()}`);
  console.log(`  cpmmAmmConfig    ${cfg.cpmmAmmConfig.toBase58()}`);
  console.log(`  lockProgram      ${cfg.lockProgram.toBase58()}`);
  console.log(`  graduatedFeeBps  ${cfg.graduatedFeeProtocolBps}\n`);

  // Size is load-bearing: the fee-model fields were carved out of `reserved`
  // precisely so already-deployed configs keep deserialising (D-050).
  check(cfgInfo.data.length === 277, "config is still 277 bytes", `${cfgInfo.data.length}`);
  check(cfg.protocolFeeBps + cfg.creatorFeeBps === 100, "curve fee totals 1.00%",
    `${cfg.protocolFeeBps}+${cfg.creatorFeeBps}`);
  check(cfg.graduationFeeLamports === 0n, "no separate graduation fee is charged",
    `${SOL(cfg.graduationFeeLamports)} SOL`);
  check(cfg.cpmmProgram.equals(RAYDIUM_CPMM_PROGRAM_ID_DEVNET),
    "cpmmProgram is Raydium's DEVNET CPMM");
  check(cfg.cpmmAmmConfig.equals(RAYDIUM_CPMM_AMM_CONFIG_1PCT_DEVNET),
    "graduation tier is the 1% AmmConfig (devnet index 3)");
  check(cfg.lockProgram.equals(PublicKey.default),
    "lockProgram is unset — devnet BURNS, as it must (no locker there)");

  // The tier must be an account Raydium owns, or a hostile 'config' could be
  // handed to `initialize` (REDTEAM 4c.8).
  const tierInfo = await connection.getAccountInfo(cfg.cpmmAmmConfig);
  check(tierInfo !== null && tierInfo.owner.equals(cfg.cpmmProgram),
    "the AmmConfig is owned by the CPMM program",
    tierInfo ? tierInfo.owner.toBase58() : "missing");

  // ---- every coin the program has ever created ----
  const curves = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: CURVE_LEN }],
  });
  console.log(`\n${curves.length} curve account(s)\n`);

  let migrated = 0;
  for (const { pubkey, account } of curves) {
    let curve;
    try {
      curve = decodeCurve(account.data);
    } catch (e) {
      check(false, `${pubkey.toBase58()} decodes`, (e as Error).message);
      continue;
    }
    const mint = curve.mint;
    const tag = `${mint.toBase58().slice(0, 8)}…`;
    console.log(
      `${tag}  raised ${SOL(curve.realSol)} SOL  ` +
        `${curve.migrated ? "MIGRATED" : curve.complete ? "complete" : "live"}`,
    );

    // Every curve MUST sit at its own derived address, or the scan above is
    // reading something that only looks like a curve.
    check(curvePda(mint, PROGRAM_ID).equals(pubkey), `  ${tag} is at its derived PDA`);
    check(
      curve.protocolFeeBps + curve.creatorFeeBps === 100,
      `  ${tag} carries the 1.00% fee split it launched under`,
      `${curve.protocolFeeBps}+${curve.creatorFeeBps}`,
    );

    // The protocol vault must never fall below rent-exemption, or the next
    // buy fails mid-flight (the bug create_coin's seeding exists to prevent).
    const vault = protocolVaultPda(mint, PROGRAM_ID);
    const vaultInfo = await connection.getAccountInfo(vault);
    const floor = await connection.getMinimumBalanceForRentExemption(0);
    check(
      vaultInfo !== null && vaultInfo.lamports >= floor,
      `  ${tag} protocol vault is rent-exempt`,
      vaultInfo ? `${vaultInfo.lamports} vs floor ${floor}` : "missing",
    );

    if (!curve.migrated) continue;
    migrated++;

    // A migrated curve must point at a REAL Raydium pool, and that pool must
    // hold the liquidity — this is the claim "100% of the raise reaches the
    // pool" checked against chain rather than against our own test.
    const poolInfo = await connection.getAccountInfo(curve.poolState);
    check(
      poolInfo !== null && poolInfo.owner.equals(cfg.cpmmProgram),
      `  ${tag} poolState is a Raydium CPMM pool`,
      poolInfo ? poolInfo.owner.toBase58() : "missing",
    );
    if (poolInfo) {
      const pool = decodeCpmmPool(poolInfo.data);
      const [v0, v1] = await Promise.all([
        connection.getTokenAccountBalance(pool.token0Vault).catch(() => null),
        connection.getTokenAccountBalance(pool.token1Vault).catch(() => null),
      ]);
      console.log(
        `        pool ${curve.poolState.toBase58().slice(0, 8)}…  ` +
          `vault0 ${v0?.value.uiAmountString ?? "?"}  vault1 ${v1?.value.uiAmountString ?? "?"}`,
      );
      const lpSupply = await connection.getTokenSupply(pool.lpMint).catch(() => null);
      // Devnet has no locker, so migrate BURNS. The check is on the LP MINT's
      // real supply, not on the pool's `lp_supply` field: Raydium never mints
      // the 100 it locks at initialize (it just subtracts it) and only
      // decrements its own counter on withdraw, so after our burn the pool
      // still reports its original number while the mint reports the truth.
      // Zero is the strongest form of the guarantee — not "the LP is held
      // somewhere safe" but "no LP exists, so no withdraw is possible".
      check(
        lpSupply !== null && BigInt(lpSupply.value.amount) === 0n,
        `  ${tag} LP supply is ZERO — every LP token was burned`,
        lpSupply
          ? `mint ${lpSupply.value.amount}, pool counter ${pool.lpSupply}`
          : "unreadable",
      );
    }

    // ...and on the burn branch there must be NO graduated-fee record, which
    // is exactly what the UI keys off to say "burned" rather than "locked".
    const gradInfo = await connection.getAccountInfo(graduatedFeesPda(mint, PROGRAM_ID));
    check(gradInfo === null, `  ${tag} has no graduated-fee record (burn branch)`);
  }

  // ---- creator vaults ----
  const creators = new Set(curves.map((c) => decodeCurve(c.account.data).creator.toBase58()));
  console.log(`\n${creators.size} distinct creator(s)`);
  for (const c of creators) {
    const v = creatorVaultPda(new PublicKey(c), PROGRAM_ID);
    const info = await connection.getAccountInfo(v);
    console.log(`  ${c.slice(0, 8)}…  vault ${info ? SOL(info.lamports) : "—"} SOL`);
  }

  console.log(
    `\n${curves.length} coins, ${migrated} migrated. ` +
      (failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`),
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
