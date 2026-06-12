/**
 * Live holder snapshot for `distribute` inputs (spec 6.8): reads who holds
 * a mint right now via RPC getProgramAccounts (or Helius DAS when
 * HELIUS_API_KEY is set) and, given a lamport total, prints the pro-rata
 * ClaimShare list + the merkle root a distribute proposal would pin.
 * Read-only; no keys, no sends.
 *
 *   npx tsx scripts/snapshot-holders.ts <mint> [totalLamports] [--exclude k1,k2] [--legacy-token]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildClaimTree, proRataShares } from "../packages/sdk/src";
import {
  RpcHolderSnapshot,
  makeHolderSnapshotSource,
} from "../packages/backend/src";

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  if (args.length < 1) {
    console.error(
      "usage: snapshot-holders.ts <mint> [totalLamports] [--exclude k1,k2] [--legacy-token]",
    );
    process.exit(1);
  }
  const mint = new PublicKey(args[0]!);
  const totalLamports = args[1] ? BigInt(args[1]) : undefined;
  const exclude = (flags.find((f) => f.startsWith("--exclude=")) ?? "")
    .split("=")[1]
    ?.split(",")
    .filter(Boolean)
    .map((k) => new PublicKey(k));

  const rpcUrl =
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const heliusKey = process.env.HELIUS_API_KEY;
  const connection = new Connection(rpcUrl, "confirmed");
  const tokenProgramId = flags.includes("--legacy-token")
    ? TOKEN_PROGRAM_ID
    : undefined;
  const source = makeHolderSnapshotSource({
    connection,
    ...(heliusKey
      ? { heliusUrl: `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` }
      : {}),
    ...(tokenProgramId ? { tokenProgramId } : {}),
  });

  // --largest: skip gPA and use the capped top-20 read directly (the
  // public RPC's gPA is index-excluded AND per-method rate-limited).
  const snap = flags.includes("--largest")
    ? await new RpcHolderSnapshot(connection, tokenProgramId).snapshotViaLargestAccounts(
        mint,
      )
    : await source.snapshotHolders(mint);
  console.log(
    JSON.stringify(
      {
        mint: mint.toBase58(),
        source: heliusKey ? "das" : "rpc",
        slot: snap.slot,
        holderAccounts: snap.holders.length,
        holders: snap.holders.map((h) => ({
          owner: h.owner.toBase58(),
          amount: h.amount.toString(),
        })),
      },
      null,
      2,
    ),
  );

  if (totalLamports !== undefined) {
    const r = proRataShares({
      holders: snap.holders,
      totalLamports,
      ...(exclude ? { excludeOwners: exclude } : {}),
    });
    const tree = buildClaimTree(r.shares);
    console.log(
      JSON.stringify(
        {
          totalLamports: totalLamports.toString(),
          heldSupply: r.heldSupply.toString(),
          allocatedLamports: r.allocatedLamports.toString(),
          dustLamports: r.dustLamports.toString(),
          merkleRoot: tree.root.toString("hex"),
          shares: r.shares.map((s) => ({
            claimant: s.claimant.toBase58(),
            lamports: s.lamports.toString(),
          })),
        },
        null,
        2,
      ),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
