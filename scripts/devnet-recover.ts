/**
 * Recover devnet SOL that testing left stranded.
 *
 * Read-only by default: it prints every lamport it can see, says who can
 * actually claim it, and does nothing. `--apply` performs only the recoveries
 * that destroy nothing:
 *
 *   - **empty token accounts** — each holds 2,039,280 lamports of rent and
 *     nothing else. Closing one is pure recovery.
 *   - **creator fee vaults** we own — `collect_creator_fee` sweeps everything
 *     above the rent floor to the creator.
 *   - **protocol fee vaults** of MIGRATED coins — `collect_protocol_fee`
 *     sweeps to `config.fee_recipient`. Pre-graduation vaults are deliberately
 *     skipped: that balance is the migration reserve, and the program refuses
 *     the sweep anyway.
 *
 * `--burn` additionally burns leftover TEST TOKENS so their accounts can be
 * closed too. It is a separate flag because it is the only irreversible thing
 * here — on devnet those tokens are worthless, but "worthless" is a judgement
 * about this cluster, not a property of the instruction, and the same script
 * pointed at mainnet would destroy real balances.
 *
 * Two things it will NOT do, and reports instead:
 *
 *   - **closing the deployed programs.** That is the largest recoverable
 *     amount by far, and it would delete the deployment every gate in
 *     GATES.md is evidence about. It needs a human decision, not a flag.
 *   - **DAO treasuries.** Governance-owned by construction: the only way out
 *     is a proposal through the gate, which costs a voting window plus a
 *     hold-up to recover a fraction of a SOL.
 *
 *   pnpm tsx scripts/devnet-recover.ts [--apply] [--burn]
 */
import { readFileSync } from "node:fs";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createBurnInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import {
  buildCollectCreatorFeeIx,
  buildCollectProtocolFeeIx,
  configPda,
  creatorVaultPda,
  decodeConfig,
  decodeCurve,
  protocolVaultPda,
} from "../packages/sdk/src/launchpad";

const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const GATE_ID = new PublicKey("4UioBmH3WkwYbLN6tumLGrUpXGMwFwcaxt1jbUcZE7Cy");

const APPLY = process.argv.includes("--apply");
const BURN = process.argv.includes("--burn");

/** Curve account length — the size filter that keeps Config out of the scan. */
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
/** Rent floor for a vault PDA (a bare system account). */
const VAULT_RENT_FLOOR = 890_880n;

const SOL = (l: bigint | number) => (Number(l) / 1e9).toFixed(9);

const payer = () =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );

async function send(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ...ixs,
  );
  return sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const signer = payer();
  const me = signer.publicKey;
  const before = await connection.getBalance(me);
  console.log(`wallet ${me.toBase58()}`);
  console.log(`balance ${SOL(before)} SOL`);
  console.log(APPLY ? "\nMODE: APPLY\n" : "\nMODE: read-only (pass --apply to act)\n");

  let recovered = 0n;

  // ---- 1. token accounts -------------------------------------------------
  const tokenAccounts = await connection.getTokenAccountsByOwner(me, {
    programId: TOKEN_PROGRAM_ID,
  });
  const empty: { address: PublicKey; lamports: number }[] = [];
  const held: { address: PublicKey; mint: PublicKey; amount: bigint; lamports: number }[] = [];
  for (const { pubkey, account } of tokenAccounts.value) {
    const mint = new PublicKey(account.data.subarray(0, 32));
    const amount = account.data.readBigUInt64LE(64);
    if (amount === 0n) empty.push({ address: pubkey, lamports: account.lamports });
    else held.push({ address: pubkey, mint, amount, lamports: account.lamports });
  }
  const emptyRent = empty.reduce((n, a) => n + BigInt(a.lamports), 0n);
  const heldRent = held.reduce((n, a) => n + BigInt(a.lamports), 0n);
  console.log(`token accounts: ${empty.length} empty (${SOL(emptyRent)} SOL of rent), ` +
    `${held.length} holding tokens (${SOL(heldRent)} SOL of rent)`);

  if (APPLY && empty.length > 0) {
    // Batched: each close is tiny, and one transaction per account would pay
    // more in fees than a couple of them return.
    for (let i = 0; i < empty.length; i += 12) {
      const slice = empty.slice(i, i + 12);
      const sig = await send(
        connection,
        signer,
        slice.map((a) => createCloseAccountInstruction(a.address, me, me)),
      );
      console.log(`  closed ${slice.length} empty account(s)  ${sig}`);
    }
    recovered += emptyRent;
  }

  if (held.length > 0) {
    for (const h of held) {
      console.log(`  ${h.address.toBase58().slice(0, 8)}…  mint ${h.mint.toBase58().slice(0, 8)}…  ` +
        `${h.amount} units  rent ${SOL(h.lamports)}`);
    }
    if (APPLY && BURN) {
      for (const h of held) {
        const sig = await send(connection, signer, [
          createBurnInstruction(h.address, h.mint, me, h.amount),
          createCloseAccountInstruction(h.address, me, me),
        ]);
        console.log(`  burned + closed ${h.address.toBase58().slice(0, 8)}…  ${sig}`);
      }
      recovered += heldRent;
    } else if (!BURN) {
      console.log(`  (pass --burn to burn these TEST tokens and reclaim ${SOL(heldRent)} SOL)`);
    }
  }

  // ---- 2. fee vaults -----------------------------------------------------
  const cfgInfo = await connection.getAccountInfo(configPda(PROGRAM_ID));
  if (!cfgInfo) throw new Error("no config account");
  const cfg = decodeConfig(cfgInfo.data);
  const iAmFeeRecipient = cfg.feeRecipient.equals(me);
  console.log(`\nconfig.feeRecipient ${cfg.feeRecipient.toBase58()}` +
    `${iAmFeeRecipient ? " (me)" : " (NOT me — protocol fees are not mine to sweep)"}`);

  const curves = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: CURVE_LEN }],
  });
  console.log(`${curves.length} curve(s) on chain`);

  const creators = new Map<string, PublicKey>();
  for (const { account } of curves) {
    const cu = decodeCurve(account.data);
    creators.set(cu.creator.toBase58(), cu.creator);
  }

  for (const creator of creators.values()) {
    const vault = creatorVaultPda(creator, PROGRAM_ID);
    const info = await connection.getAccountInfo(vault);
    if (!info) continue;
    const claim = BigInt(info.lamports) - VAULT_RENT_FLOOR;
    const mine = creator.equals(me);
    if (claim <= 0n) continue;
    console.log(`creator vault ${creator.toBase58().slice(0, 8)}…  claimable ${SOL(claim)}` +
      `${mine ? "" : "  (not mine — only the creator can sweep it)"}`);
    if (APPLY && mine) {
      // The builder needs a curve to prove the creator's claim; any coin this
      // creator launched works, since the vault is per-CREATOR not per-coin.
      const anyMint = [...curves]
        .map((x) => decodeCurve(x.account.data))
        .find((x) => x.creator.equals(creator))!.mint;
      const sig = await send(connection, signer, [
        buildCollectCreatorFeeIx({
          payer: me,
          creator: me,
          mint: anyMint,
          programId: PROGRAM_ID,
        }),
      ]);
      console.log(`  swept  ${sig}`);
      recovered += claim;
    }
  }

  for (const { account } of curves) {
    const cu = decodeCurve(account.data);
    const vault = protocolVaultPda(cu.mint, PROGRAM_ID);
    const info = await connection.getAccountInfo(vault);
    if (!info) continue;
    const claim = BigInt(info.lamports) - VAULT_RENT_FLOOR;
    if (claim <= 0n) continue;
    if (!cu.migrated) {
      // Not a missed opportunity: this balance is the graduation reserve, and
      // the program refuses the sweep until migrate has spent it.
      console.log(`protocol vault ${cu.mint.toBase58().slice(0, 8)}…  ${SOL(claim)} — RESERVED (not yet migrated)`);
      continue;
    }
    console.log(`protocol vault ${cu.mint.toBase58().slice(0, 8)}…  claimable ${SOL(claim)}`);
    if (APPLY && iAmFeeRecipient) {
      const sig = await send(connection, signer, [
        buildCollectProtocolFeeIx({
          payer: me,
          mint: cu.mint,
          feeRecipient: cfg.feeRecipient,
          // Address-checked by the program against the config, so it has to be
          // the tier the config NAMES, not the cluster default.
          ammConfig: cfg.cpmmAmmConfig,
          programId: PROGRAM_ID,
        }),
      ]);
      console.log(`  swept  ${sig}`);
      recovered += claim;
    }
  }

  // ---- 3. reported, never touched ---------------------------------------
  console.log("\nNOT recovered (deliberately):");
  for (const [name, id] of [["launchpad-curve", PROGRAM_ID], ["proposal-gate", GATE_ID]] as const) {
    const info = await connection.getAccountInfo(id);
    if (!info) continue;
    const programData = new PublicKey(info.data.subarray(4, 36));
    const pd = await connection.getAccountInfo(programData);
    const total = BigInt(info.lamports) + BigInt(pd?.lamports ?? 0);
    console.log(`  ${name}: ${SOL(total)} SOL of rent — recoverable ONLY by ` +
      `\`solana program close\`, which deletes the deployment every gate in ` +
      `GATES.md is evidence about. Human decision, not a flag.`);
  }
  console.log("  DAO treasuries: governance-owned. The only way out is a proposal");
  console.log("    through the gate — a voting window plus a hold-up to recover a");
  console.log("    fraction of a SOL. Left alone unless someone asks.");

  const after = await connection.getBalance(me);
  console.log(`\nbalance ${SOL(after)} SOL` +
    (APPLY ? `  (net ${SOL(after - before)} this run; gross recovered ${SOL(recovered)} before fees)` : ""));
  if (!APPLY) {
    console.log(`\nwould recover ${SOL(emptyRent)} SOL now` +
      `, or ${SOL(emptyRent + heldRent)} SOL with --burn, plus any vault sweeps above.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
