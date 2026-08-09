/**
 * Client-side launch orchestrator (no server). Drives the connected wallet
 * through the on-chain ceremony using the SAME instruction builders the
 * integration suite proves against real binaries:
 *
 *   1. create treasury (Squads multisig; createKey co-signs)
 *   2. collect launch fee (optional)
 *   3. create coin on OUR bonding curve (mint co-signs; creator = the DAO's
 *      vault PDA, INV-CREATOR-ARG) + optional dev buy
 *   4. create DAO (council? -> realm + governance; realm authority -> DAO)
 *   5. prefund the native treasury (execution rent headroom)
 *
 * Step 3 is the same curve the plain "simple token" path uses — one rail for
 * both, so a DAO token is just a coin whose CREATOR is the treasury: trading
 * fees accrue to the DAO's creator vault and anyone can crank them home.
 * The realm is built with NO voter-weight addin: vote weight == deposited
 * tokens 1:1 (D-013). Ephemeral keypairs live only for the flow's duration.
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
import {
  buildBuyIx,
  buildCreateCoinIx,
  configPda,
  decodeConfig,
} from "@daofun/sdk/launchpad";
import { buyQuote, initialState, tokensForSolInput } from "@daofun/sdk/curve-math";
import { TIER_FLOORS } from "@daofun/sdk/matrix";
import { launchpadProgramId } from "./cluster";
import type {
  GovernanceMode,
  GovernanceParams,
  MarketCapTier,
} from "@daofun/sdk/launch-form";
import type { WalletSender } from "./wallet-sender";

/** Curve supply: 1,000,000,000 tokens × 10^6 decimals (config-confirmed). */
const DEFAULT_TOTAL_SUPPLY = 1_000_000_000_000_000n;
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
function realParams(input: LaunchInput, totalSupply: bigint): GovernanceParams {
  const bps = BigInt(TIER_FLOORS[input.tier].proposalThresholdSupplyBps);
  const raw = (totalSupply * bps) / 10_000n;
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
  // Council AND guarded both need a fresh council mint keypair co-signing;
  // in guarded mode its single token goes to the gate authority PDA.
  const councilMint =
    input.mode === "council" || input.mode === "guarded" ? Keypair.generate() : undefined;

  const predicted = deriveGovernanceChainFromMint(mint.publicKey);
  const { vaultPda } = deriveTreasuryPdas(createKey.publicKey);
  const signatures: string[] = [];

  // The curve's live config is the source of truth for supply, fee recipient
  // and the starting reserves — read it once, use it for the governance
  // threshold AND the dev buy quote.
  const programId = launchpadProgramId();
  const cfgInfo = await connection.getAccountInfo(configPda(programId));
  if (!cfgInfo) {
    throw new Error(
      "The launchpad config is not initialized on this cluster — a DAO token needs the curve program deployed here.",
    );
  }
  const cfg = decodeConfig(cfgInfo.data);
  const params = realParams(input, cfg.tokenTotalSupply || DEFAULT_TOTAL_SUPPLY);

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

  // 3. create_coin on OUR curve — mint co-signs; the CREATOR is the DAO's
  //    vault PDA (INV-CREATOR-ARG: creator is an argument, never a signer),
  //    so every trade's creator fee accrues to the treasury from block one.
  const tokenIxs: TransactionInstruction[] = [
    buildCreateCoinIx({
      payer: wallet,
      mint: mint.publicKey,
      creator: vaultPda,
      name: input.metadata.name,
      symbol: input.metadata.symbol,
      uri: input.metadata.uri,
      programId,
    }),
  ];
  if (input.devBuyLamports && input.devBuyLamports > 0n) {
    // Quote against the curve's OWN starting state (same math the program
    // prices with), then cap the cost with a 2% slippage allowance.
    const state = initialState({
      initialVirtualSol: cfg.initialVirtualSol,
      initialVirtualToken: cfg.initialVirtualToken,
      initialRealToken: cfg.initialRealToken,
      tokenTotalSupply: cfg.tokenTotalSupply,
      protocolFeeBps: cfg.protocolFeeBps,
      creatorFeeBps: cfg.creatorFeeBps,
    });
    const tokensOut = tokensForSolInput(state, input.devBuyLamports);
    if (tokensOut > 0n) {
      const cost = buyQuote(state, tokensOut).totalCost;
      tokenIxs.push(
        buildBuyIx({
          user: wallet,
          mint: mint.publicKey,
          creator: vaultPda,
          tokenAmount: tokensOut,
          maxSolCost: cost + cost / 50n,
          programId,
        }),
      );
    }
  }
  await send("Create coin", tokenIxs, [mint]);

  // 4. DAO. Token-2022 mint -> no VSR addin (D-013).
  const councilSetup = councilMint
    ? input.mode === "guarded"
      ? {
          mint: councilMint.publicKey,
          members: [],
          vetoThresholdPercent: 0,
          mintRentLamports: BigInt(
            await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          ),
        }
      : input.council
      ? {
          mint: councilMint.publicKey,
          members: input.council.members.map((m) => new PublicKey(m)),
          vetoThresholdPercent: input.council.vetoThresholdPercent,
          mintRentLamports: BigInt(
            await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          ),
        }
      : undefined
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
