/**
 * Shared bankrun harness for the gate integration suites: loads the REAL
 * mainnet program binaries from tests/fixtures (dumped by
 * scripts/dump-mainnet-programs.ts), stands up production-parameter DAOs
 * with the SAME sdk builders the launch flow uses, and drives proposals
 * through the production propose builder (buildProposeIxs).
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import BN from "bn.js";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  GovernanceAccountParser,
  Proposal,
  ProposalState,
  ProposalTransaction,
  Vote,
  VoteChoice,
  VoteKind,
  createInstructionData,
  getProposalTransactionAddress,
  getTokenOwnerRecordAddress,
  withCastVote,
  withDepositGoverningTokens,
  withExecuteTransaction,
  withFinalizeVote,
} from "@solana/spl-governance";
import * as multisig from "@sqds/multisig";
import {
  Clock,
  start,
  type AddedAccount,
  type AddedProgram,
  type ProgramTestContext,
} from "solana-bankrun";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
} from "../../packages/sdk/src/constants";
import { resolveGovernanceParams } from "../../packages/sdk/src/matrix";
import { buildCreateDaoIxs } from "../../packages/sdk/src/governance";
import { buildCreateTreasuryIx } from "../../packages/sdk/src/treasury";
import { buildProposeIxs } from "../../packages/sdk/src/proposal";
import { deriveGovernanceChainFromMint } from "../../packages/sdk/src/pda";
import type {
  GovernanceMode,
  GovernanceParams,
} from "../../packages/sdk/src/types";
import { hashWrappedInstructionSet } from "../../packages/backend/src/chain-reader";

const FIXTURES = resolve(__dirname, "..", "fixtures");
process.env.SBF_OUT_DIR = FIXTURES;

// Program binaries are committed gzipped (zero-padded programdata
// compresses ~10x); inflate once so bankrun can load the .so files.
//
// Write to a per-process temp name and rename into place. Every test file
// runs in its own worker process and they all execute this block at import,
// so a plain `writeFileSync` to the final path is a race: worker A is still
// streaming 1.4 MB out when worker B's `existsSync` says yes, and B hands
// bankrun a TRUNCATED ELF. rename(2) is atomic within a directory, so a
// reader sees either no file or the whole file, never half of one. Costs a
// few MB of duplicate writes on the very first run after a clone and nothing
// thereafter.
for (const f of readdirSync(FIXTURES)) {
  if (f.endsWith(".so.gz")) {
    const so = join(FIXTURES, f.slice(0, -".gz".length));
    if (!existsSync(so)) {
      const tmp = `${so}.${process.pid}.tmp`;
      writeFileSync(tmp, gunzipSync(readFileSync(join(FIXTURES, f))));
      renameSync(tmp, so);
    }
  }
}

export const PROGRAM_VERSION = 3;
export const SUPPLY = 200_000_000_000n; // 200k tokens at 6 decimals, like the mainnet run
export const BASE_VOTING_TIME_S = 3 * 86400; // production default (D-012) — we warp
export const MICRO_HOLDUP_S = 72 * 3600;
export const VAULT_FUND = 890_880;
// D-016: the native treasury pays Squads rent at execution time
// (VaultTransactionCreate 2,429,040 + ProposalCreate 2,046,240) on top of
// its own 890,880 floor.
export const TREASURY_PREFUND = 6_000_000;
export const TEST_TIMEOUT = 300_000;

export const squadsConfig = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/squads-program-config.json"), "utf8"),
) as { address: string; owner: string; lamports: number; treasury: string; dataBase64: string };

// ---------- the bankrun wedge: watchdog + one retry ----------
//
// Six of twenty-two full-suite runs on this 4-core box died with a bare
// "Test timed out in 300000ms" — no assertion, no error, no clue. The cause,
// finally caught (D-051):
//
//   thread 'tokio-runtime-worker' panicked at solana-program-test-1.18.0:716
//   Program file data not available for `"̌\r\0\0\0\0\x91ϥ…  (DaV3yst…)
//
// The program NAME is freed heap memory — those bytes are a pointer sitting in
// a reclaimed slot — while the program ID beside it is intact. So the JS string
// backing `AddedProgram.name` is read after release inside the native bridge,
// solana-program-test cannot find a file by that garbage name, and it panics.
// The panic kills the tokio task WITHOUT settling the napi promise, so the JS
// `await` in front of `start()` waits forever: the worker's event loop goes
// completely idle (nothing but tinypool's IPC pipes — no timers, no pending
// libuv requests) and the test burns its full timeout in silence.
//
// Confirmed by the logs: every wedged run contains that panic, every green run
// contains zero. Not starvation and not memory (13 GB free, no OOM), and not
// reproducible by hammering `start()` alone — 80 back-to-back creations across
// two concurrent workers, none.
//
// Two things follow, and both are here:
//
//   1. WATCHDOG. Every bankrun call races a 60s timer, so a wedge fails saying
//      WHICH CALL wedged instead of stalling 300s and leaving orphaned workers
//      holding cores for the next run. A suite file normally finishes in about
//      a second, so the budget is pure headroom.
//   2. ONE RETRY of context creation. The corruption is a per-call race, so a
//      fresh `start()` is overwhelmingly likely to succeed — this turns a red
//      run into a run that is 60s slower and green. Measured: of six
//      verification runs, two wedged, both retried, all six finished 20/20.
//      It is loud on stderr and never retries anything but context creation —
//      re-running a transaction blind could double-apply it.
//
// Set BANKRUN_CALL_TIMEOUT_MS=0 to disable both (e.g. under a debugger).
const CALL_TIMEOUT_MS = Number(process.env.BANKRUN_CALL_TIMEOUT_MS ?? 60_000);

export function watchdog<T>(label: string, p: Promise<T>): Promise<T> {
  if (!(CALL_TIMEOUT_MS > 0)) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `bankrun call never settled after ${CALL_TIMEOUT_MS}ms: ${label}. ` +
              "This is the known native-module wedge, not a slow test — see the " +
              "watchdog note in tests/helpers/bankrun-harness.ts.",
          ),
        ),
      CALL_TIMEOUT_MS,
    );
  });
  // Not unref'd: when the wedge hits, this timer is the ONLY thing left
  // holding the loop, and an unref'd one would never fire.
  return Promise.race([p, bell]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Wrap a context so every `banksClient` call carries the watchdog. Tests use
 * `ctx.banksClient` directly all over the place, so guarding the client once
 * here beats asking two dozen call sites to remember.
 */
function guarded(ctx: ProgramTestContext): ProgramTestContext {
  if (!(CALL_TIMEOUT_MS > 0)) return ctx;
  const client = ctx.banksClient as unknown as Record<string, unknown>;
  const proxy = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Promise
          ? watchdog(`banksClient.${String(prop)}`, out)
          : out;
      };
    },
  });
  Object.defineProperty(ctx, "banksClient", {
    value: proxy,
    configurable: true,
    enumerable: true,
  });
  return ctx;
}

/**
 * Create a context, and survive the wedge described above by trying once more.
 * Only creation is retried — a transaction is not safe to replay blind.
 */
async function startResilient(
  label: string,
  make: () => Promise<ProgramTestContext>,
): Promise<ProgramTestContext> {
  try {
    return guarded(await watchdog(label, make()));
  } catch (e) {
    process.stderr.write(
      `\n[bankrun] ${label} wedged (${(e as Error).message.split(".")[0]}); ` +
        "retrying once — see D-051.\n",
    );
    return guarded(await watchdog(`${label} [retry]`, make()));
  }
}

// ---------- bankrun harness ----------

/**
 * A context with exactly the programs asked for — no governance, no Squads.
 * Use this instead of importing `start` from solana-bankrun directly, so the
 * watchdog covers every call rather than most of them.
 */
export function startGuarded(
  programs: AddedProgram[],
  accounts: AddedAccount[] = [],
): Promise<ProgramTestContext> {
  return startResilient(`start(${programs.map((p) => p.name).join("+")})`, () =>
    start(programs, accounts),
  );
}

/**
 * Which cluster's governance stack to stand up.
 *
 * They are NOT the same program. Devnet runs spl-governance **3.1.2** and a
 * different Squads build; mainnet runs the **3.1.4** fork everything in this
 * repo was verified against. Anything claiming a devnet run proves mainnet
 * behaviour has to earn it — see tests/devnet-governance-parity.
 */
export type GovStack = "mainnet" | "devnet";

const DEVNET_SQUADS_CONFIG = JSON.parse(
  readFileSync(resolve(__dirname, "../fixtures/squads-program-config-devnet.json"), "utf8"),
) as typeof squadsConfig;

/**
 * Which Squads ProgramConfig a given context was built with.
 *
 * Squads validates the `treasury` account passed to `multisig_create_v2`
 * against the one in its on-chain ProgramConfig, and the two clusters name
 * DIFFERENT treasuries. Pinning the mainnet address here — which the harness
 * used to do unconditionally — meant every DAO test would pass on mainnet
 * binaries and fail on devnet's, so no test could ever have caught a
 * cluster-config mismatch. Production was always correct: both the app and
 * the backend read it from chain with `fetchProgramConfigTreasury`. This map
 * gives the harness the same cluster-awareness without touching call sites.
 */
const CTX_TREASURY = new WeakMap<ProgramTestContext, PublicKey>();

export function programConfigTreasuryFor(ctx: ProgramTestContext): PublicKey {
  return CTX_TREASURY.get(ctx) ?? new PublicKey(squadsConfig.treasury);
}

export function startCtx(
  extraPrograms: AddedProgram[] = [],
  extraAccounts: AddedAccount[] = [],
  stack: GovStack = "mainnet",
): Promise<ProgramTestContext> {
  const devnet = stack === "devnet";
  const cfg = devnet ? DEVNET_SQUADS_CONFIG : squadsConfig;
  const label = `start(${stack} governance+squads${extraPrograms
    .map((p) => `+${p.name}`)
    .join("")})`;
  return startResilient(label, () =>
    start(
      [
        {
          name: devnet ? "spl_governance_devnet" : "spl_governance",
          programId: SPL_GOVERNANCE_PROGRAM_ID,
        },
        {
          name: devnet ? "squads_v4_devnet" : "squads_v4",
          programId: SQUADS_V4_PROGRAM_ID,
        },
        ...extraPrograms,
      ],
      [
        ...extraAccounts,
        {
          address: new PublicKey(cfg.address),
          info: {
            lamports: cfg.lamports,
            data: Buffer.from(cfg.dataBase64, "base64"),
            owner: new PublicKey(cfg.owner),
            executable: false,
          },
        },
      ],
    ).then((ctx) => {
      CTX_TREASURY.set(ctx, new PublicKey(cfg.treasury));
      return ctx;
    }),
  );
}

/**
 * Context with the pump stack loaded on top of governance + Squads, plus
 * the live pump/PumpFees/mayhem state accounts from the fixtures dump.
 */
export function startPumpCtx(): Promise<ProgramTestContext> {
  const pumpAccounts = (
    JSON.parse(readFileSync(join(FIXTURES, "pump-accounts.json"), "utf8")) as {
      address: string;
      owner: string;
      lamports: number;
      dataBase64: string;
    }[]
  ).map((a) => ({
    address: new PublicKey(a.address),
    info: {
      lamports: a.lamports,
      data: Buffer.from(a.dataBase64, "base64"),
      owner: new PublicKey(a.owner),
      executable: false,
    },
  }));
  return startCtx(
    [
      { name: "pump", programId: PUMP_PROGRAM_ID },
      { name: "pump_fees", programId: PUMP_FEES_PROGRAM_ID },
      { name: "pump_amm", programId: PUMP_AMM_PROGRAM_ID },
      { name: "token_2022", programId: TOKEN_2022_PROGRAM_ID },
    ],
    pumpAccounts,
  );
}

export async function send(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer?: Keypair,
): Promise<void> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const payer = feePayer ?? ctx.payer;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  await ctx.banksClient.processTransaction(tx);
}

/**
 * Send one instruction as a v0 transaction with a throwaway address lookup
 * table compressing its static keys — the packing for inserts whose DATA
 * (e.g. an account-heavy vaultTransactionExecute) leaves no room for the
 * outer account list in a legacy tx. Production senders need the same
 * fallback (recorded with GATE 0c).
 */
export async function sendWithAlt(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  payer: Keypair,
): Promise<void> {
  // recentSlot must be IN SlotHashes; the current slot itself never is
  // (at genesis the sysvar holds only slot 0 while getSlot() is 1).
  const slot = (await ctx.banksClient.getSlot()) - 1n;
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  // Program ids must stay static in v0 messages; everything else can load
  // from the table.
  const addresses = [
    ...new Map(
      ixs
        .flatMap((ix) => ix.keys)
        .filter((k) => !k.isSigner) // signers must be static
        .map((k) => [k.pubkey.toBase58(), k.pubkey]),
    ).values(),
  ];
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    lookupTable: table,
    authority: payer.publicKey,
    payer: payer.publicKey,
    addresses,
  });
  await send(ctx, [createIx, extendIx], [payer], payer);

  // table entries activate in the NEXT slot
  ctx.warpToSlot((await ctx.banksClient.getSlot()) + 1n);
  const info = await ctx.banksClient.getAccount(table);
  const lookup = new AddressLookupTableAccount({
    key: table,
    state: AddressLookupTableAccount.deserialize(Buffer.from(info!.data)),
  });

  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message([lookup]);
  const vtx = new VersionedTransaction(msg);
  vtx.sign([payer]);
  await ctx.banksClient.processTransaction(vtx);
}


/**
 * D-009: prefund every missing writable account an instruction set touches
 * to the rent floor — trades pay sub-floor fee crumbs to fee recipients,
 * and the runtime rejects transactions that leave accounts below the
 * floor. Program-init'd accounts tolerate pre-funded addresses.
 */
export async function prefundMissingWritables(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
): Promise<void> {
  const RENT_FLOOR = 890_880;
  const targets = new Map<string, PublicKey>();
  for (const ix of ixs) {
    for (const k of ix.keys) {
      if (k.isWritable && !k.isSigner) targets.set(k.pubkey.toBase58(), k.pubkey);
    }
  }
  const transfers: TransactionInstruction[] = [];
  for (const target of targets.values()) {
    if (!(await ctx.banksClient.getAccount(target))) {
      transfers.push(
        SystemProgram.transfer({
          fromPubkey: ctx.payer.publicKey,
          toPubkey: target,
          lamports: RENT_FLOOR,
        }),
      );
    }
  }
  if (transfers.length > 0) await send(ctx, transfers, []);
}

/**
 * Like send(), but returns the compute units the transaction consumed
 * (Stage 2 CU-budget suite, spec Section 8: "measured per executed
 * governance tx; fail test if within 15% of limit").
 */
export async function sendMeasured(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  feePayer?: Keypair,
): Promise<bigint> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const payer = feePayer ?? ctx.payer;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...signers.filter((s) => !s.publicKey.equals(payer.publicKey)));
  const result = await ctx.banksClient.tryProcessTransaction(tx);
  if (result.result !== null) {
    throw new Error(
      [result.result, ...(result.meta?.logMessages ?? [])].join("\n"),
    );
  }
  return result.meta?.computeUnitsConsumed ?? 0n;
}

/** Sends expecting failure; returns error + program logs for assertions. */
export async function sendExpectFail(
  ctx: ProgramTestContext,
  ixs: TransactionInstruction[],
  signers: Keypair[],
): Promise<string> {
  const [blockhash] = (await ctx.banksClient.getLatestBlockhash())!;
  const tx = new Transaction();
  tx.add(...ixs);
  tx.recentBlockhash = blockhash;
  tx.feePayer = ctx.payer.publicKey;
  tx.sign(ctx.payer, ...signers.filter((s) => !s.publicKey.equals(ctx.payer.publicKey)));
  const result = await ctx.banksClient.tryProcessTransaction(tx);
  if (result.result === null) {
    throw new Error("transaction unexpectedly succeeded");
  }
  return [result.result, ...(result.meta?.logMessages ?? [])].join("\n");
}

export async function warpSeconds(ctx: ProgramTestContext, seconds: number) {
  const clock = await ctx.banksClient.getClock();
  ctx.setClock(
    new Clock(
      clock.slot,
      clock.epochStartTimestamp,
      clock.epoch,
      clock.leaderScheduleEpoch,
      clock.unixTimestamp + BigInt(seconds),
    ),
  );
}

export async function balance(ctx: ProgramTestContext, addr: PublicKey): Promise<number> {
  const acc = await ctx.banksClient.getAccount(addr);
  return acc ? Number(acc.lamports) : 0;
}

export async function readGov<T>(
  ctx: ProgramTestContext,
  addr: PublicKey,
  type: new (...args: never[]) => T,
): Promise<T> {
  const info = await ctx.banksClient.getAccount(addr);
  if (!info) throw new Error(`account ${addr.toBase58()} not found`);
  return GovernanceAccountParser(type as never)(addr, {
    executable: info.executable,
    owner: info.owner,
    lamports: Number(info.lamports),
    data: Buffer.from(info.data),
  }).account as T;
}

// ---------- DAO setup (same builders as the launch flow) ----------

export interface Dao {
  mint: PublicKey;
  realm: PublicKey;
  governance: PublicKey;
  nativeTreasury: PublicKey;
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  params: GovernanceParams;
  voter: Keypair;
  voterTor: PublicKey;
  councilMint: PublicKey | null;
  councilMember: Keypair;
  councilTor: PublicKey | null;
}

export async function mintRent(ctx: ProgramTestContext): Promise<bigint> {
  const rent = await ctx.banksClient.getRent();
  return rent.minimumBalance(BigInt(MINT_SIZE));
}

export async function createDao(
  ctx: ProgramTestContext,
  mode: GovernanceMode,
): Promise<Dao> {
  const payer = ctx.payer;
  const voter = Keypair.generate();
  const councilMember = Keypair.generate();
  const mint = Keypair.generate();
  const councilMintKp = Keypair.generate();
  const createKey = Keypair.generate();
  const rentLamports = Number(await mintRent(ctx));

  // Community mint: full supply to the voter, then no mint authority
  // (mirrors a pump launch's null authority, INV-5).
  const voterAta = getAssociatedTokenAddressSync(mint.publicKey, voter.publicKey);
  await send(
    ctx,
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: voter.publicKey,
        lamports: 1_000_000_000,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: councilMember.publicKey,
        lamports: 1_000_000_000,
      }),
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: rentLamports,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, 6, payer.publicKey, null),
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        voterAta,
        voter.publicKey,
        mint.publicKey,
      ),
      createMintToInstruction(mint.publicKey, voterAta, payer.publicKey, SUPPLY),
      createSetAuthorityInstruction(
        mint.publicKey,
        payer.publicKey,
        AuthorityType.MintTokens,
        null,
      ),
    ],
    [mint],
  );

  const params = resolveGovernanceParams({
    mode,
    tier: "micro",
    communitySupply: SUPPLY,
  });

  // Treasury first, against the advance-derived native treasury (the same
  // ordering the launch orchestrator uses).
  const chain = deriveGovernanceChainFromMint(mint.publicKey);
  const treasury = buildCreateTreasuryIx({
    payer: payer.publicKey,
    predictedNativeTreasury: chain.nativeTreasury,
    createKey: createKey.publicKey,
    // Whichever cluster's ProgramConfig this context was built with — Squads
    // checks it, and the two clusters differ.
    programConfigTreasury: programConfigTreasuryFor(ctx),
  });
  await send(ctx, [treasury.ix], [createKey]);

  // D-016: the real program accepted rentCollector == native treasury, so
  // execution rent flows back to the DAO when Squads accounts close.
  const msInfo = await ctx.banksClient.getAccount(treasury.multisigPda);
  const [msState] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msInfo!.lamports),
    data: Buffer.from(msInfo!.data),
  });
  expect(msState.rentCollector?.toBase58()).toBe(chain.nativeTreasury.toBase58());

  const dao = await buildCreateDaoIxs({
    mint: mint.publicKey,
    payer: payer.publicKey,
    mode,
    params,
    ...(mode === "council"
      ? {
          council: {
            mint: councilMintKp.publicKey,
            members: [councilMember.publicKey],
            vetoThresholdPercent: 50,
            mintRentLamports: BigInt(rentLamports),
          },
        }
      : mode === "guarded"
        ? {
            // Gate v2 (D-042): the ceremony derives the sole member — the
            // gate authority PDA. No human council exists in guarded mode.
            council: {
              mint: councilMintKp.publicKey,
              members: [],
              vetoThresholdPercent: 0,
              mintRentLamports: BigInt(rentLamports),
            },
          }
        : {}),
    baseVotingTimeSeconds: BASE_VOTING_TIME_S,
    communityVoterWeightAddin: null, // no-addin realm (D-013 MVP fallback)
  });
  expect(dao.realm.toBase58()).toBe(chain.realm.toBase58());
  expect(dao.nativeTreasury.toBase58()).toBe(chain.nativeTreasury.toBase58());

  // Execution order is the builder's contract: council mint first (the
  // realm registers it), then realm, then governance.
  if (dao.groups.council.length > 0) {
    await send(ctx, dao.groups.council, [councilMintKp]);
  }
  await send(ctx, dao.groups.realmSetup, []);
  await send(ctx, dao.groups.governanceSetup, []);

  // Voting power: deposit the full supply (no-addin: deposit == weight).
  const depositIxs: TransactionInstruction[] = [];
  await withDepositGoverningTokens(
    depositIxs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    voterAta,
    mint.publicKey,
    voter.publicKey,
    voter.publicKey,
    payer.publicKey,
    new BN(SUPPLY.toString()),
  );
  await send(ctx, depositIxs, [voter]);
  const voterTor = await getTokenOwnerRecordAddress(
    SPL_GOVERNANCE_PROGRAM_ID,
    dao.realm,
    mint.publicKey,
    voter.publicKey,
  );

  // Council membership: deposit the 1 council token the ceremony minted.
  let councilTor: PublicKey | null = null;
  if (mode === "council") {
    const memberAta = getAssociatedTokenAddressSync(
      councilMintKp.publicKey,
      councilMember.publicKey,
      true,
    );
    const ixs: TransactionInstruction[] = [];
    await withDepositGoverningTokens(
      ixs,
      SPL_GOVERNANCE_PROGRAM_ID,
      PROGRAM_VERSION,
      dao.realm,
      memberAta,
      councilMintKp.publicKey,
      councilMember.publicKey,
      councilMember.publicKey,
      payer.publicKey,
      new BN(1),
    );
    await send(ctx, ixs, [councilMember]);
    councilTor = await getTokenOwnerRecordAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      dao.realm,
      councilMintKp.publicKey,
      councilMember.publicKey,
    );
  }

  // Fund: vault gets the lamports the proposals will sweep; treasury gets
  // its floor + Squads execution rent (D-016).
  await send(
    ctx,
    [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: treasury.vaultPda,
        lamports: VAULT_FUND,
      }),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: dao.nativeTreasury,
        lamports: TREASURY_PREFUND,
      }),
    ],
    [],
  );

  return {
    mint: mint.publicKey,
    realm: dao.realm,
    governance: dao.governance,
    nativeTreasury: dao.nativeTreasury,
    multisigPda: treasury.multisigPda,
    vaultPda: treasury.vaultPda,
    params,
    voter,
    voterTor,
    councilMint:
      mode === "council" || mode === "guarded" ? councilMintKp.publicKey : null,
    councilMember,
    councilTor,
  };
}

// ---------- proposal lifecycle ----------

export interface MadeProposal {
  proposal: PublicKey;
  wrapped: TransactionInstruction[];
  ptAddrs: PublicKey[];
  innerHash: string;
  recipient: PublicKey;
}

export async function proposeSweep(
  ctx: ProgramTestContext,
  dao: Dao,
  proposalIndex: number,
): Promise<MadeProposal> {
  const recipient = Keypair.generate().publicKey;
  const inner = [
    SystemProgram.transfer({
      fromPubkey: dao.vaultPda,
      toPubkey: recipient,
      lamports: VAULT_FUND,
    }),
  ];
  const made = await proposeInner(ctx, dao, proposalIndex, inner, "sweep vault");
  return { ...made, recipient };
}

/** Propose an arbitrary inner set through the production builder. */
export async function proposeInner(
  ctx: ProgramTestContext,
  dao: Dao,
  proposalIndex: number,
  inner: TransactionInstruction[],
  label: string,
  directIxs?: TransactionInstruction[],
): Promise<MadeProposal> {
  const recipient = PublicKey.default; // unused for non-sweep proposals

  const msAccount = await ctx.banksClient.getAccount(dao.multisigPda);
  const [ms] = multisig.accounts.Multisig.fromAccountInfo({
    executable: false,
    owner: SQUADS_V4_PROGRAM_ID,
    lamports: Number(msAccount!.lamports),
    data: Buffer.from(msAccount!.data),
  });
  const txIndex = BigInt(ms.transactionIndex.toString()) + 1n;

  // The production propose builder (D-017: descriptionLink == hash;
  // per-transaction hold-up; ExecutionAdapter wrapping).
  const made = await buildProposeIxs({
    realm: dao.realm,
    governance: dao.governance,
    governingTokenMint: dao.mint,
    tokenOwnerRecord: dao.voterTor,
    governanceAuthority: dao.voter.publicKey,
    // payer == proposer keeps inserts single-signer (size headroom for
    // account-heavy execute inserts)
    payer: dao.voter.publicKey,
    proposalIndex,
    name: `${label} #${proposalIndex}`,
    innerIxs: inner,
    ...(directIxs ? { directIxs } : {}),
    wrapCtx: {
      multisigPda: dao.multisigPda,
      vaultIndex: 0,
      transactionIndex: txIndex,
      member: dao.nativeTreasury,
    },
    holdUpSeconds: dao.params.holdUpSeconds,
  });

  await send(ctx, made.groups.create, [dao.voter], dao.voter);
  const ptAddrs: PublicKey[] = [];
  for (const [i, group] of made.groups.inserts.entries()) {
    try {
      await send(ctx, group, [dao.voter], dao.voter);
    } catch (e) {
      if (!/too large/i.test((e as Error).message) || group.length !== 1) throw e;
      // account-heavy execute insert: pack as v0 + lookup table
      await sendWithAlt(ctx, group, dao.voter);
    }
    ptAddrs.push(
      await getProposalTransactionAddress(
        SPL_GOVERNANCE_PROGRAM_ID,
        PROGRAM_VERSION,
        made.proposal,
        0,
        i,
      ),
    );
  }
  await send(ctx, made.groups.signOff, [dao.voter], dao.voter);

  // D-017 verified on chain state: the proposal's descriptionLink IS the
  // artifact hash.
  const onChain = await readGov(ctx, made.proposal, Proposal);
  expect(onChain.descriptionLink).toBe(made.innerInstructionSetHash);

  return {
    proposal: made.proposal,
    wrapped: made.wrapped,
    ptAddrs,
    innerHash: made.innerInstructionSetHash,
    recipient,
  };
}

export async function castCommunityYes(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voterTor,
    dao.voterTor,
    dao.voter.publicKey,
    dao.mint,
    new Vote({
      voteType: VoteKind.Approve,
      approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
      deny: undefined,
      veto: undefined,
    }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [dao.voter]);
}

export async function castCouncilVeto(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
) {
  const ixs: TransactionInstruction[] = [];
  await withCastVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voterTor, // proposal owner's record
    dao.councilTor!,
    dao.councilMember.publicKey,
    dao.councilMint!, // the VETOING token is the council mint (D-011)
    new Vote({
      voteType: VoteKind.Veto,
      approveChoices: undefined,
      deny: undefined,
      veto: true,
    }),
    ctx.payer.publicKey,
  );
  await send(ctx, ixs, [dao.councilMember]);
}

export async function finalizeAfterVotingWindow(
  ctx: ProgramTestContext,
  dao: Dao,
  proposal: PublicKey,
): Promise<ProposalState> {
  await warpSeconds(ctx, BASE_VOTING_TIME_S + 10);
  const ixs: TransactionInstruction[] = [];
  await withFinalizeVote(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.realm,
    dao.governance,
    proposal,
    dao.voterTor,
    dao.mint,
  );
  await send(ctx, ixs, []);
  return (await readGov(ctx, proposal, Proposal)).state;
}

export async function executeIxsFor(
  dao: Dao,
  made: MadeProposal,
  i: number,
): Promise<TransactionInstruction[]> {
  const ixs: TransactionInstruction[] = [];
  await withExecuteTransaction(
    ixs,
    SPL_GOVERNANCE_PROGRAM_ID,
    PROGRAM_VERSION,
    dao.governance,
    made.proposal,
    made.ptAddrs[i]!,
    [createInstructionData(made.wrapped[i]!)],
  );
  return ixs;
}

export async function executeAll(ctx: ProgramTestContext, dao: Dao, made: MadeProposal) {
  for (let i = 0; i < made.ptAddrs.length; i++) {
    // Production tx hygiene: governance execute -> Squads execute -> inner
    // CPIs stack beyond the 200k default (the mainnet runs sent 400k too).
    const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
    const ixs = [cu, ...(await executeIxsFor(dao, made, i))];
    try {
      await send(ctx, ixs, []);
    } catch (e) {
      if (!/too large/i.test((e as Error).message)) throw e;
      // account-heavy direct-leg execute (D-022): v0 + lookup table
      await sendWithAlt(ctx, ixs, ctx.payer);
    }
  }
}

/** INV-9: re-read the ProposalTransactions and hash what will execute. */
export async function chainHashOf(
  ctx: ProgramTestContext,
  made: MadeProposal,
): Promise<string | null> {
  const onChain: TransactionInstruction[] = [];
  for (const addr of made.ptAddrs) {
    const pt = await readGov(ctx, addr, ProposalTransaction);
    for (const d of pt.getAllInstructions()) {
      onChain.push(
        new TransactionInstruction({
          programId: d.programId,
          keys: d.accounts.map((a) => ({
            pubkey: a.pubkey,
            isSigner: a.isSigner,
            isWritable: a.isWritable,
          })),
          data: Buffer.from(d.data),
        }),
      );
    }
  }
  return hashWrappedInstructionSet(onChain);
}
