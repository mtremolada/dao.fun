/**
 * Cluster audit — read the LIVE state and check it against what the program,
 * the SDK and the docs claim. Read-only: it signs nothing and spends nothing,
 * so it is safe to run any time, and it is the thing to run before believing
 * a gate.
 *
 * The point is not "does it print nicely" — it is that every invariant we
 * assert in bankrun is re-checked against real accounts a real deploy
 * produced. A test suite can only prove things about the binary it loads;
 * this proves the deployed binary was configured and driven correctly.
 *
 *   pnpm tsx scripts/devnet-audit.ts [--cluster devnet|mainnet] [--rpc <url>]
 *
 * `--cluster mainnet` exists so the mainnet audit (LAUNCH.md L-26) is a FLAG
 * on a script proven over months on devnet, rather than a new script written
 * on launch day. The cluster changes three expectations and nothing else:
 *
 *   - the CPMM program and the 1% AmmConfig are different ADDRESSES per
 *     cluster (the tier's INDEX differs too — 1 on mainnet, 3 on devnet —
 *     which is exactly why the config stores an address, not an index);
 *   - `lockProgram` MUST be unset on devnet, because Raydium's locker is not
 *     deployed there and migrate must burn; on mainnet it must be SET, or
 *     every graduation silently takes the burn branch and the whole
 *     post-graduation fee model quietly does not exist;
 *   - migrated pools therefore have LP supply zero on devnet (burned), and
 *     LP held by the locker on mainnet.
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
  PROPOSAL_GATE_PROGRAM_ID,
  RAYDIUM_CPMM_AMM_CONFIG_1PCT,
  RAYDIUM_CPMM_AMM_CONFIG_1PCT_DEVNET,
  RAYDIUM_CPMM_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID_DEVNET,
  RAYDIUM_LOCK_PROGRAM_ID,
} from "../packages/sdk/src/constants";

const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] ?? null : null;
}

const CLUSTER = (arg("cluster") ?? "devnet") as "devnet" | "mainnet";
if (CLUSTER !== "devnet" && CLUSTER !== "mainnet") {
  throw new Error(`--cluster must be devnet or mainnet, got ${CLUSTER}`);
}
const IS_DEVNET = CLUSTER === "devnet";
const RPC =
  arg("rpc") ??
  (IS_DEVNET ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

/** What the config must name on this cluster. */
const EXPECTED = IS_DEVNET
  ? {
      cpmm: RAYDIUM_CPMM_PROGRAM_ID_DEVNET,
      tier: RAYDIUM_CPMM_AMM_CONFIG_1PCT_DEVNET,
      tierLabel: "devnet index 3",
      // Not "we chose not to lock": there is no locker on devnet to point at.
      lock: PublicKey.default,
    }
  : {
      cpmm: RAYDIUM_CPMM_PROGRAM_ID,
      tier: RAYDIUM_CPMM_AMM_CONFIG_1PCT,
      tierLabel: "mainnet index 1",
      lock: RAYDIUM_LOCK_PROGRAM_ID,
    };

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
  console.log(`cluster ${CLUSTER}\nRPC ${RPC}\nprogram ${PROGRAM_ID.toBase58()}\n`);

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

  // The gate is a second deployment of ours and deserves the same treatment:
  // an Anchor program whose address differs from its `declare_id!` refuses
  // every instruction, so "deployed" and "deployed at the RIGHT address" are
  // different claims (D-053).
  const gateInfo = await connection.getAccountInfo(PROPOSAL_GATE_PROGRAM_ID);
  if (!gateInfo) {
    console.log(`\nproposal-gate ${PROPOSAL_GATE_PROGRAM_ID.toBase58()} — NOT DEPLOYED here`);
  } else {
    const gateFixture = gunzipSync(
      readFileSync(resolve(__dirname, "../tests/fixtures/proposal_gate.so.gz")),
    );
    const gatePd = new PublicKey(gateInfo.data.subarray(4, 36));
    const gatePdInfo = await connection.getAccountInfo(gatePd);
    const gateDeployed = gatePdInfo!.data.subarray(45);
    console.log(`\nproposal-gate ${PROPOSAL_GATE_PROGRAM_ID.toBase58()}`);
    check(gateInfo.executable, "  gate is executable");
    check(
      Buffer.from(gateDeployed.subarray(0, gateFixture.length)).equals(
        Buffer.from(gateFixture),
      ),
      "  deployed gate == tests/fixtures/proposal_gate.so.gz",
      `${gateFixture.length} bytes`,
    );
    check(
      gateDeployed.subarray(gateFixture.length).every((b) => b === 0),
      "  everything past the gate ELF is zero padding",
    );
  }

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
  check(cfg.cpmmProgram.equals(EXPECTED.cpmm),
    `cpmmProgram is Raydium's ${CLUSTER.toUpperCase()} CPMM`,
    cfg.cpmmProgram.toBase58());
  check(cfg.cpmmAmmConfig.equals(EXPECTED.tier),
    `graduation tier is the 1% AmmConfig (${EXPECTED.tierLabel})`,
    cfg.cpmmAmmConfig.toBase58());
  check(cfg.lockProgram.equals(EXPECTED.lock),
    IS_DEVNET
      ? "lockProgram is unset — devnet BURNS, as it must (no locker there)"
      : "lockProgram is Raydium's locker — mainnet must LOCK, not burn",
    cfg.lockProgram.equals(PublicKey.default) ? "unset" : cfg.lockProgram.toBase58());

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
      // The check is on the LP MINT's real supply, not on the pool's
      // `lp_supply` field: Raydium never mints the 100 it locks at initialize
      // (it just subtracts it) and only decrements its own counter on
      // withdraw, so the pool still reports its original number while the
      // mint reports the truth.
      if (IS_DEVNET) {
        // No locker here, so migrate BURNS. Zero is the strongest form of the
        // guarantee — not "the LP is held somewhere safe" but "no LP exists,
        // so no withdraw is possible".
        check(
          lpSupply !== null && BigInt(lpSupply.value.amount) === 0n,
          `  ${tag} LP supply is ZERO — every LP token was burned`,
          lpSupply
            ? `mint ${lpSupply.value.amount}, pool counter ${pool.lpSupply}`
            : "unreadable",
        );
      } else {
        // On mainnet the LP is LOCKED, not burned, and that is what earns the
        // perpetual fee. A zero supply here would mean the lock branch
        // silently did not run — the exact failure that would leave the whole
        // post-graduation fee model non-existent while every screen still
        // said "graduated".
        check(
          lpSupply !== null && BigInt(lpSupply.value.amount) > 0n,
          `  ${tag} LP supply is NON-ZERO — the LP was locked, not burned`,
          lpSupply ? `mint ${lpSupply.value.amount}` : "unreadable",
        );
      }
    }

    // The graduated-fee record is the branch marker: absent means burned,
    // present means locked. It is what the UI keys off, so an audit that
    // ignored it could pass while the surface told users the opposite.
    const gradInfo = await connection.getAccountInfo(graduatedFeesPda(mint, PROGRAM_ID));
    check(
      IS_DEVNET ? gradInfo === null : gradInfo !== null,
      IS_DEVNET
        ? `  ${tag} has no graduated-fee record (burn branch)`
        : `  ${tag} HAS a graduated-fee record (lock branch)`,
    );
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
