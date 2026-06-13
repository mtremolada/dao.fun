/**
 * Client-side launch orchestrator (no server). Drives the connected wallet
 * through the on-chain ceremony using the SAME instruction builders the
 * integration suite proves against real mainnet binaries:
 *
 *   1. create treasury (Squads multisig; createKey co-signs)
 *   2. collect launch fee (optional)
 *   3. create coin (pump create_v2; mint co-signs; creator = vault PDA, INV-1)
 *   4. create DAO (council? -> realm + governance; realm authority -> DAO)
 *   5. prefund the native treasury (execution rent headroom)
 *
 * pump v2 mints are Token-2022, which the deployed VSR rejects (D-013), so
 * the realm is built with NO voter-weight addin: vote weight == deposited
 * tokens 1:1. Ephemeral keypairs live only for the duration of the flow.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { MINT_SIZE } from "@solana/spl-token";
import { deriveGovernanceChainFromMint } from "@daofun/sdk/pda";
import {
  buildCreateTreasuryIx,
  deriveTreasuryPdas,
  fetchProgramConfigTreasury,
} from "@daofun/sdk/treasury";
import { buildCreateDaoIxs } from "@daofun/sdk/governance";
import { PumpFunRail } from "@daofun/sdk/rails/pumpfun";
import { TIER_FLOORS } from "@daofun/sdk/matrix";
import type {
  GovernanceMode,
  GovernanceParams,
  MarketCapTier,
} from "@daofun/sdk/launch-form";
import type { WalletSender } from "./wallet-sender";

/** pump.fun fixed supply: 1,000,000,000 tokens × 10^6 decimals. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;
const PREFUND_LAMPORTS = 6_000_000;

export interface LaunchInput {
  mode: GovernanceMode;
  tier: MarketCapTier;
  params: GovernanceParams;
  metadata: { name: string; symbol: string; uri: string };
  devBuyLamports?: bigint;
  council?: { members: string[]; vetoThresholdPercent: number };
  launchFee?: { treasury: string; lamports: bigint };
}

export interface LaunchStepState {
  step: string;
  status: "running" | "done" | "error";
  signature?: string;
  error?: string;
}

export interface LaunchResult {
  mint: string;
  realm: string;
  governance: string;
  vault: string;
  nativeTreasury: string;
  signatures: string[];
}

/** Real-supply proposal threshold (the form preview uses a placeholder supply). */
function realParams(input: LaunchInput): GovernanceParams {
  const bps = BigInt(TIER_FLOORS[input.tier].proposalThresholdSupplyBps);
  const raw = (PUMP_TOTAL_SUPPLY * bps) / 10_000n;
  return {
    ...input.params,
    proposalThresholdTokens: raw > 0n ? raw : 1n,
  };
}

export async function runLaunch(
  connection: Connection,
  sender: WalletSender,
  input: LaunchInput,
  onStep: (s: LaunchStepState) => void,
): Promise<LaunchResult> {
  const wallet = new PublicKey(sender.address);
  const mint = Keypair.generate();
  const createKey = Keypair.generate();
  const councilMint =
    input.mode === "council" ? Keypair.generate() : undefined;

  const predicted = deriveGovernanceChainFromMint(mint.publicKey);
  const { vaultPda } = deriveTreasuryPdas(createKey.publicKey);
  const params = realParams(input);
  const signatures: string[] = [];

  async function send(
    step: string,
    ixs: TransactionInstruction[],
    extraSigners: Keypair[],
  ): Promise<void> {
    onStep({ step, status: "running" });
    try {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = wallet;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash("confirmed")
      ).blockhash;
      if (extraSigners.length) tx.partialSign(...extraSigners);
      const sig = await sender.signAndSend(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      signatures.push(sig);
      onStep({ step, status: "done", signature: sig });
    } catch (e) {
      onStep({ step, status: "error", error: (e as Error).message });
      throw e;
    }
  }

  // 1. Squads treasury — createKey co-signs.
  const programConfigTreasury = await fetchProgramConfigTreasury(connection);
  const { ix: treasuryIx } = buildCreateTreasuryIx({
    payer: wallet,
    predictedNativeTreasury: predicted.nativeTreasury,
    createKey: createKey.publicKey,
    programConfigTreasury,
  });
  await send("Create treasury", [treasuryIx], [createKey]);

  // 2. Launch fee (optional).
  if (input.launchFee && input.launchFee.lamports > 0n) {
    await send(
      "Collect launch fee",
      [
        SystemProgram.transfer({
          fromPubkey: wallet,
          toPubkey: new PublicKey(input.launchFee.treasury),
          lamports: Number(input.launchFee.lamports),
        }),
      ],
      [],
    );
  }

  // 3. pump create_v2 — mint co-signs; creator is the vault PDA (INV-1).
  const rail = new PumpFunRail(connection);
  const tokenIxs = await rail.buildCreateTokenIxs(
    {
      metadata: input.metadata,
      launcher: wallet,
      rail: "pumpfun",
      daoConfig: { mode: input.mode, marketCapTier: input.tier },
      ...(input.devBuyLamports && input.devBuyLamports > 0n
        ? { devBuyLamports: input.devBuyLamports }
        : {}),
    },
    vaultPda,
    mint,
  );
  await send("Create coin", tokenIxs, [mint]);

  // 4. DAO. Token-2022 mint -> no VSR addin (D-013).
  const councilSetup =
    councilMint && input.council
      ? {
          mint: councilMint.publicKey,
          members: input.council.members.map((m) => new PublicKey(m)),
          vetoThresholdPercent: input.council.vetoThresholdPercent,
          mintRentLamports: BigInt(
            await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          ),
        }
      : undefined;
  const dao = await buildCreateDaoIxs({
    mint: mint.publicKey,
    payer: wallet,
    mode: input.mode,
    params,
    communityVoterWeightAddin: null,
    ...(councilSetup ? { council: councilSetup } : {}),
  });
  if (dao.groups.council.length > 0) {
    await send(
      "Create council",
      dao.groups.council,
      councilMint ? [councilMint] : [],
    );
  }
  await send("Create realm", dao.groups.realmSetup, []);
  await send("Create governance", dao.groups.governanceSetup, []);

  // 5. Prefund the native treasury for its first execution's rent (D-016).
  await send(
    "Prefund treasury",
    [
      SystemProgram.transfer({
        fromPubkey: wallet,
        toPubkey: predicted.nativeTreasury,
        lamports: PREFUND_LAMPORTS,
      }),
    ],
    [],
  );

  return {
    mint: mint.publicKey.toBase58(),
    realm: predicted.realm.toBase58(),
    governance: predicted.governance.toBase58(),
    vault: vaultPda.toBase58(),
    nativeTreasury: predicted.nativeTreasury.toBase58(),
    signatures,
  };
}
