/**
 * Test client for the launchpad suites. Instruction building, PDAs, and
 * decoders all DELEGATE to the SDK's browser-safe launchpad module
 * (packages/sdk/src/launchpad) — so the bankrun suites, which drive these
 * builders against the real deployed binaries, are simultaneously the proof
 * that the SDK builders are correct. The two cannot drift.
 *
 * Only test-only utilities live here directly: bankrun context bootstrap,
 * SPL account decoders, and `grindMint` for both wSOL sort orders.
 *
 * Rebuild the program fixture (toolchain in DECISIONS.md D-035):
 *   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
 *   export CARGO_NET_GIT_FETCH_WITH_CLI=true
 *   cargo-build-sbf --manifest-path programs/launchpad-curve/Cargo.toml
 *   gzip -9 -c programs/target/deploy/launchpad_curve.so \
 *     > tests/fixtures/launchpad_curve.so.gz
 *   rm -f tests/fixtures/launchpad_curve.so   # or the stale .so keeps loading
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import type { AddedAccount, ProgramTestContext } from "solana-bankrun";
import {
  MPL_TOKEN_METADATA_PROGRAM_ID,
  RAYDIUM_CPMM_PROGRAM_ID,
} from "../../packages/sdk/src/constants";
import type { CurveParams } from "../../packages/sdk/src/curve-math";
import {
  LAUNCHPAD_PROGRAM_ID,
  ixDiscriminator,
  raydiumCpmmAddresses,
  buildBuyIx,
  buildCollectCreatorFeeIx,
  buildCollectProtocolFeeIx,
  buildCreateCoinIx,
  buildInitializeConfigIx,
  buildMigrateIx,
  buildSellIx,
  buildUpdateConfigIx,
  configPda,
  cpmmPoolAccounts as sdkCpmmPoolAccounts,
  creatorVaultPda,
  protocolVaultPda,
  curvePda,
  decodeCurve,
  metadataPda as sdkMetadataPda,
  migrationAuthorityPda,
  migrationWsolPda,
  poolStatePda,
  solVaultPda,
  type ConfigParamsInput,
  type DecodedCurve,
} from "../../packages/sdk/src/launchpad";
import { startCtx } from "./bankrun-harness";

export {
  LAUNCHPAD_PROGRAM_ID,
  configPda,
  curvePda,
  solVaultPda,
  creatorVaultPda,
  protocolVaultPda,
  migrationAuthorityPda,
  migrationWsolPda,
  poolStatePda,
};
export type { DecodedCurve };

const FIXTURES = resolve(__dirname, "..", "fixtures");

/** bankrun loads the MAINNET Raydium binary, so the builders target mainnet. */
const RAY = raydiumCpmmAddresses("mainnet");

export const disc = ixDiscriminator;

export const metadataPda = (mint: PublicKey) =>
  sdkMetadataPda(mint, MPL_TOKEN_METADATA_PROGRAM_ID);

export const cpmmPoolAccounts = (mint: PublicKey) =>
  sdkCpmmPoolAccounts(mint, RAY);

export function cpmmFixtureAccounts(): AddedAccount[] {
  return (
    JSON.parse(
      readFileSync(join(FIXTURES, "cpmm-accounts.json"), "utf8"),
    ) as { address: string; owner: string; lamports: number; dataBase64: string }[]
  ).map((a) => ({
    address: new PublicKey(a.address),
    info: {
      lamports: a.lamports,
      data: Buffer.from(a.dataBase64, "base64"),
      owner: new PublicKey(a.owner),
      executable: false,
    },
  }));
}

/** bankrun with our program plus the real Raydium and Metaplex binaries. */
export function startLaunchpadCtx(): Promise<ProgramTestContext> {
  return startCtx(
    [
      { name: "launchpad_curve", programId: LAUNCHPAD_PROGRAM_ID },
      { name: "cpmm", programId: RAYDIUM_CPMM_PROGRAM_ID },
      { name: "mpl_token_metadata", programId: MPL_TOKEN_METADATA_PROGRAM_ID },
    ],
    cpmmFixtureAccounts(),
  );
}

export type ConfigInput = ConfigParamsInput;

export function initializeConfigIx(args: {
  payer: PublicKey;
  authority: PublicKey;
  feeRecipient: PublicKey;
  params: ConfigInput;
}): TransactionInstruction {
  return buildInitializeConfigIx({ ...args, cluster: "mainnet", ray: RAY });
}

export function updateConfigIx(args: {
  authority: PublicKey;
  params: ConfigInput;
}): TransactionInstruction {
  return buildUpdateConfigIx(args);
}

export function createCoinIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  name?: string;
  symbol?: string;
  uri?: string;
}): TransactionInstruction {
  return buildCreateCoinIx({
    payer: args.payer,
    mint: args.mint,
    creator: args.creator,
    name: args.name ?? "Test Coin",
    symbol: args.symbol ?? "TEST",
    uri: args.uri ?? "https://example.invalid/meta.json",
  });
}

export function buyIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  /** Ignored: the protocol fee now accrues in a per-mint PDA the builder
   *  derives. Kept so existing suites read unchanged. */
  feeRecipient?: PublicKey;
  tokenAmount: bigint;
  maxSolCost: bigint;
}): TransactionInstruction {
  return buildBuyIx(args);
}

export function sellIx(args: {
  user: PublicKey;
  mint: PublicKey;
  creator: PublicKey;
  /** Ignored — see buyIx. */
  feeRecipient?: PublicKey;
  tokenAmount: bigint;
  minSolOutput: bigint;
}): TransactionInstruction {
  return buildSellIx(args);
}

export function migrateIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
}): TransactionInstruction {
  return buildMigrateIx({ ...args, cluster: "mainnet", ray: RAY });
}

export function collectProtocolFeeIx(args: {
  payer: PublicKey;
  mint: PublicKey;
  feeRecipient: PublicKey;
}): TransactionInstruction {
  return buildCollectProtocolFeeIx({ ...args, ammConfig: RAY.ammConfig });
}

export function collectCreatorFeeIx(args: {
  payer: PublicKey;
  creator: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return buildCollectCreatorFeeIx(args);
}

// ---------- decoders (test-only) ----------

export async function readCurve(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<DecodedCurve> {
  const info = await ctx.banksClient.getAccount(curvePda(mint));
  if (!info) throw new Error("bonding curve account missing");
  return decodeCurve(Buffer.from(info.data));
}

export async function tokenBalance(
  ctx: ProgramTestContext,
  account: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(account);
  return info ? Buffer.from(info.data).readBigUInt64LE(64) : 0n;
}

export async function mintSupply(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<bigint> {
  const info = await ctx.banksClient.getAccount(mint);
  if (!info) throw new Error("mint missing");
  return Buffer.from(info.data).readBigUInt64LE(36);
}

/** SPL mint layout: COption<Pubkey> authority at 0, freeze at 46. */
export async function mintAuthorities(
  ctx: ProgramTestContext,
  mint: PublicKey,
): Promise<{ mintAuthority: boolean; freezeAuthority: boolean }> {
  const info = await ctx.banksClient.getAccount(mint);
  if (!info) throw new Error("mint missing");
  const d = Buffer.from(info.data);
  return {
    mintAuthority: d.readUInt32LE(0) === 1,
    freezeAuthority: d.readUInt32LE(46) === 1,
  };
}

/** re-export for tests that name the params type. */
export type { CurveParams };

/**
 * Grinds a mint keypair that sorts on the requested side of wSOL. WSOL's
 * first byte is 6, so "below" is ~2.3% of the keyspace — a few dozen tries.
 * Both branches matter: the WSOL-as-token_1 path is the one almost nobody
 * exercises in production.
 */
export function grindMint(below: boolean): Keypair {
  for (let i = 0; i < 20_000; i += 1) {
    const kp = Keypair.generate();
    const isBelow =
      Buffer.compare(kp.publicKey.toBuffer(), NATIVE_MINT.toBuffer()) < 0;
    if (isBelow === below) return kp;
  }
  throw new Error(`could not grind a mint sorting ${below ? "below" : "above"} wSOL`);
}
