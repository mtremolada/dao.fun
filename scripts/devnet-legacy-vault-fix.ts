/**
 * The legacy protocol-vault gap: prove it, fix it, prove the fix.
 *
 * Coins created BEFORE the fee-model upgrade have no `["protocol-vault", mint]`
 * account, because the instruction that seeds it did not exist yet. `buy`
 * routes the 0.70% protocol fee there with a plain system transfer, and a
 * system transfer to a NON-EXISTENT account creates it — which the runtime
 * then rejects unless the new account lands rent-exempt. So on those coins
 * every buy whose protocol fee is under the 890,880-lamport floor fails, i.e.
 * every buy under about 0.127 SOL. New coins are unaffected: `create_coin`
 * seeds the vault, and both `migrate` and `collect_protocol_fee` retain the
 * floor, so it can never be drained back below it.
 *
 * The fix needs no program change and no authority — a protocol vault is a
 * system-owned PDA, so anyone may fund it. This script does it in the honest
 * order: attempt the buy and show the failure, fund, attempt again and show
 * it work.
 *
 *   pnpm tsx scripts/devnet-legacy-vault-fix.ts            # report only
 *   pnpm tsx scripts/devnet-legacy-vault-fix.ts --apply    # fund the vaults
 *   pnpm tsx scripts/devnet-legacy-vault-fix.ts --apply --prove <mint>
 */
import { readFileSync } from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildBuyIx,
  curvePda,
  decodeCurve,
  protocolVaultPda,
} from "../packages/sdk/src/launchpad";
import { tokensForSolInput } from "../packages/sdk/src/curve-math";

const PROGRAM_ID = new PublicKey(
  process.env.LAUNCHPAD_PROGRAM_ID ?? "DaV3ystSgyM9ALDCbtv9AzyfEtAuPe9x8jVacYDdSU7V",
);
const RPC = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const CURVE_LEN = 8 + 32 + 32 + 8 * 4 + 2 + 2 + 1 + 1 + 32 + 1;
const APPLY = process.argv.includes("--apply");
const proveIdx = process.argv.indexOf("--prove");
const PROVE = proveIdx > -1 ? process.argv[proveIdx + 1] : undefined;

function payer(): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(".wallets/deployer.json", "utf8"))),
  );
}

/** A 0.01 SOL buy — small enough that its 0.70% fee is far under the floor. */
async function tryBuy(
  connection: Connection,
  signer: Keypair,
  mint: PublicKey,
  creator: PublicKey,
): Promise<{ ok: boolean; detail: string }> {
  const info = await connection.getAccountInfo(curvePda(mint, PROGRAM_ID));
  if (!info) return { ok: false, detail: "no curve" };
  const curve = decodeCurve(info.data);
  const solIn = 10_000_000n; // 0.01 SOL
  const tokens = tokensForSolInput(
    {
      virtualSol: curve.virtualSol,
      virtualToken: curve.virtualToken,
      realSol: curve.realSol,
      realToken: curve.realToken,
      protocolFeeBps: curve.protocolFeeBps,
      creatorFeeBps: curve.creatorFeeBps,
      complete: curve.complete,
    },
    solIn,
  );
  if (tokens <= 0n) return { ok: false, detail: "quote is zero" };
  const ix = buildBuyIx({
    user: signer.publicKey,
    mint,
    creator,
    tokenAmount: tokens,
    maxSolCost: solIn * 2n,
    programId: PROGRAM_ID,
  });
  try {
    const sig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(ix),
      [signer],
      { commitment: "confirmed" },
    );
    return { ok: true, detail: sig };
  } catch (e) {
    const msg = (e as Error).message.replace(/\s+/g, " ").slice(0, 220);
    return { ok: false, detail: msg };
  }
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const signer = payer();
  const floor = await connection.getMinimumBalanceForRentExemption(0);
  console.log(`payer ${signer.publicKey.toBase58()}  rent floor ${floor}\n`);

  const curves = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ dataSize: CURVE_LEN }],
  });

  const missing: { mint: PublicKey; creator: PublicKey; migrated: boolean }[] = [];
  for (const { account } of curves) {
    const curve = decodeCurve(account.data);
    const info = await connection.getAccountInfo(protocolVaultPda(curve.mint, PROGRAM_ID));
    if (!info || info.lamports < floor) {
      missing.push({ mint: curve.mint, creator: curve.creator, migrated: curve.migrated });
    }
  }
  console.log(`${missing.length} of ${curves.length} coins have no funded protocol vault:`);
  for (const m of missing) {
    console.log(`  ${m.mint.toBase58()}${m.migrated ? "  (migrated — buys are over anyway)" : ""}`);
  }
  if (missing.length === 0) return;

  // ---- prove the failure, before touching anything ----
  const target = PROVE
    ? missing.find((m) => m.mint.toBase58() === PROVE)
    : missing.find((m) => !m.migrated);
  if (PROVE && !target) {
    console.log(`\n--prove ${PROVE} is not in the affected set`);
  }
  if (target && PROVE) {
    console.log(`\nBEFORE — 0.01 SOL buy on ${target.mint.toBase58().slice(0, 8)}…`);
    const before = await tryBuy(connection, signer, target.mint, target.creator);
    console.log(`  ${before.ok ? "SUCCEEDED (diagnosis wrong)" : "failed as predicted"}: ${before.detail}`);
  }

  if (!APPLY) {
    console.log("\n(report only — pass --apply to fund the vaults)");
    return;
  }

  // ---- fund ----
  // A protocol vault is a system-owned PDA with no data, so a plain transfer
  // from anyone creates it rent-exempt. No authority, no program change.
  const tx = new Transaction();
  for (const m of missing) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: protocolVaultPda(m.mint, PROGRAM_ID),
        lamports: floor,
      }),
    );
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
    commitment: "confirmed",
  });
  console.log(`\nfunded ${missing.length} vault(s) at ${floor} lamports each — ${sig}`);

  // ---- prove the fix ----
  if (target && PROVE) {
    console.log(`\nAFTER — the same 0.01 SOL buy`);
    const after = await tryBuy(connection, signer, target.mint, target.creator);
    console.log(`  ${after.ok ? "succeeded" : "STILL FAILS"}: ${after.detail}`);
    process.exit(after.ok ? 0 : 1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
