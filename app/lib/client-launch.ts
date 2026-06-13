"use client";

/**
 * Client-side launch ceremony (D-033). The full Section 2 sequence runs in the
 * browser: ephemeral keypairs (mint / Squads createKey / council mint) are
 * generated locally and co-sign each transaction alongside the user's wallet;
 * no server ever holds a key. It reuses the PROVEN, real-binary-tested
 * builders (buildCreateDaoIxs, buildCreateTreasuryIx, the pump rail) and the
 * unit-tested step machine (buildLaunchSteps / runLaunch) verbatim — this
 * module only supplies the RPC + wallet wiring (RpcLaunchStepDeps) the
 * ceremony was always designed to inject. The on-chain safety assertions
 * (INV-5 mint authority null, INV-7 sole member, predicted-PDA match) run
 * unchanged in the final step.
 */
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { getMint, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  PumpFunRail,
  buildLaunchSteps,
  runLaunch,
  MemoryLaunchStore,
  fetchProgramConfigTreasury,
  validateLaunchForm,
  type LaunchStepArgs,
  type LaunchStepDeps,
  type LaunchParams,
  type LaunchResult,
  type LaunchFormInput,
  type CouncilSetup,
} from "@daofun/sdk";
import { base64ToBytes, bytesToBase64 } from "./wallet-standard";

export interface ClientLaunchInput {
  form: LaunchFormInput;
  metadata: { name: string; symbol: string; uri: string };
  devBuyLamports?: bigint;
}

export interface ClientLaunchOpts {
  connection: Connection;
  /** Launcher wallet (base58); fee payer + transient realm authority. */
  walletAddress: string;
  /** Wallet-standard signer: base64 unsigned tx -> base64 signed tx. */
  signTransaction(txBase64: string): Promise<string>;
  /** Progress callback fired after each confirmed step. */
  onStep?: (label: string, signature: string) => void;
  feeSharesEnabled?: boolean;
}

/** Protocol fee config — build-time env, no server. */
const PROTOCOL_TREASURY = process.env.NEXT_PUBLIC_PROTOCOL_TREASURY ?? "";
const LAUNCH_FEE_LAMPORTS = BigInt(process.env.NEXT_PUBLIC_LAUNCH_FEE ?? "0");

/**
 * Build a LaunchStepDeps backed by the RPC + the user's wallet. Ephemeral
 * keypairs co-sign exactly the transactions whose message requires them
 * (createKey -> create-treasury, mint -> create-token, council mint ->
 * create-dao:council); the wallet signs as fee payer everywhere.
 */
function makeDeps(
  opts: ClientLaunchOpts,
  launcher: PublicKey,
  mint: Keypair,
  cosigners: Keypair[],
): LaunchStepDeps {
  const { connection } = opts;
  const rail = new PumpFunRail(connection, {
    ...(opts.feeSharesEnabled !== undefined
      ? { feeSharesEnabled: opts.feeSharesEnabled }
      : {}),
  });

  return {
    async sendAndConfirm(ixs, label) {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({
        feePayer: launcher,
        blockhash,
        lastValidBlockHeight,
      }).add(...ixs);

      // Co-sign with the ephemeral keypairs this message actually requires.
      const message = tx.compileMessage();
      const required = message.accountKeys
        .slice(0, message.header.numRequiredSignatures)
        .filter((k) => !k.equals(launcher));
      const needed = cosigners.filter((kp) =>
        required.some((k) => k.equals(kp.publicKey)),
      );
      if (needed.length > 0) tx.partialSign(...needed);

      const unsignedB64 = tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64");
      const signedB64 = await opts.signTransaction(unsignedB64);
      const signature = await connection.sendRawTransaction(
        base64ToBytes(signedB64),
        { skipPreflight: false },
      );
      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      opts.onStep?.(label, signature);
      return signature;
    },

    buildCreateTokenIxs(params: LaunchParams, creator: PublicKey) {
      // The rail needs the mint KEYPAIR (it co-signs the create); the step
      // machine only passes the pubkey, so we close over the keypair here.
      return rail.buildCreateTokenIxs(params, creator, mint);
    },

    fetchProgramConfigTreasury() {
      return fetchProgramConfigTreasury(connection);
    },

    async fetchMintAuthority(m: PublicKey) {
      const info = await connection.getAccountInfo(m);
      if (!info) throw new Error("mint account not found after create-token");
      const parsed = await getMint(connection, m, "confirmed", info.owner);
      return parsed.mintAuthority;
    },

    async fetchMultisigSoleMember(multisigPda: PublicKey) {
      const ms = await multisig.accounts.Multisig.fromAccountAddress(
        connection,
        multisigPda,
      );
      if (ms.members.length !== 1) {
        throw new Error(
          `multisig has ${ms.members.length} members, expected exactly 1 (INV-7)`,
        );
      }
      return ms.members[0]!.key;
    },
  };
}

/**
 * Run the full launch in the browser. Throws with the failed step on any
 * error so partial state is surfaced, never silently completed.
 */
export async function runClientLaunch(
  input: ClientLaunchInput,
  opts: ClientLaunchOpts,
): Promise<LaunchResult> {
  const validated = validateLaunchForm(input.form);
  if (!validated.ok || !validated.params) {
    throw new Error(validated.errors.join("; ") || "invalid launch form");
  }
  if (!input.metadata.name || !input.metadata.symbol || !input.metadata.uri) {
    throw new Error("token name, symbol, and metadata uri are required");
  }
  const launcher = new PublicKey(opts.walletAddress);
  const protocolTreasury =
    PROTOCOL_TREASURY.length > 0 ? new PublicKey(PROTOCOL_TREASURY) : launcher;

  const mint = Keypair.generate();
  const createKey = Keypair.generate();
  const cosigners: Keypair[] = [mint, createKey];

  let council: CouncilSetup | undefined;
  if (input.form.mode === "council") {
    const councilMint = Keypair.generate();
    cosigners.push(councilMint);
    council = {
      mint: councilMint.publicKey,
      members: (input.form.councilMembers ?? []).map((m) => new PublicKey(m)),
      vetoThresholdPercent: input.form.councilVetoThresholdPercent ?? 0,
      mintRentLamports: BigInt(
        await getMinimumBalanceForRentExemptMint(opts.connection),
      ),
    };
  }

  const launchParams: LaunchParams = {
    metadata: input.metadata,
    daoConfig: {
      mode: input.form.mode,
      marketCapTier: input.form.tier,
      ...(input.form.councilMembers
        ? { councilMembers: input.form.councilMembers.map((m) => new PublicKey(m)) }
        : {}),
      ...(input.form.councilVetoThresholdPercent !== undefined
        ? { councilVetoThresholdPercent: input.form.councilVetoThresholdPercent }
        : {}),
      ...(input.form.sovereignHoldUpSeconds !== undefined
        ? { sovereignHoldUpSeconds: input.form.sovereignHoldUpSeconds }
        : {}),
    },
    rail: "pumpfun",
    launcher,
    ...(input.devBuyLamports !== undefined
      ? { devBuyLamports: input.devBuyLamports }
      : {}),
  };

  const args: LaunchStepArgs = {
    mint: mint.publicKey,
    createKey: createKey.publicKey,
    launcher,
    protocolTreasury,
    launchFeeLamports: LAUNCH_FEE_LAMPORTS,
    daoMode: input.form.mode,
    governanceParams: validated.params,
    launchParams,
    ...(council ? { council } : {}),
  };

  const deps = makeDeps(opts, launcher, mint, cosigners);
  const { steps, getResult } = buildLaunchSteps(args, deps);
  const launchId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}`;
  const state = await runLaunch(launchId, steps, new MemoryLaunchStore());
  if (state.status !== "complete") {
    throw new Error(
      `launch failed at step "${state.failedStep}": ${state.error ?? "unknown error"}`,
    );
  }
  const result = getResult();
  if (!result) throw new Error("launch completed without a result");
  return result;
}

export { bytesToBase64 };
