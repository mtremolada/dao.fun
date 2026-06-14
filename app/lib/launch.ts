/**
 * Client-side launch orchestrator (no server). It does NOT hand-roll the
 * ceremony: it builds the SAME `buildLaunchPlan` the integration suite proves
 * end-to-end against the real mainnet binaries (launch-plan-selfservice), then
 * signs + sends each group through the connected wallet. So what users launch
 * is exactly the tested plan — F-3 fee-last, F-12 council-first, advance-derived
 * custody (INV-7), Token-2022 retargeting (D-013), and the realm-squat guard.
 *
 * pump v2 mints are Token-2022, which the deployed VSR rejects (D-013), so the
 * realm is built with NO voter-weight addin: vote weight == deposited tokens
 * 1:1. Ephemeral keypairs live only for the duration of the flow.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { MINT_SIZE } from "@solana/spl-token";
import { deriveTreasuryPdas, fetchProgramConfigTreasury } from "@daofun/sdk/treasury";
import { PumpFunRail } from "@daofun/sdk/rails/pumpfun";
import { TIER_FLOORS } from "@daofun/sdk/matrix";
import {
  buildLaunchPlan,
  extraSignersFor,
  type LaunchTxGroup,
} from "@daofun/sdk/launch-plan";
import { absoluteMaxVoteWeight } from "@daofun/sdk/governance";
import {
  computeContentCommitment,
  type EnhancedListingContent,
} from "@daofun/sdk/enhanced-listing";
import type {
  GovernanceMode,
  GovernanceParams,
  MarketCapTier,
} from "@daofun/sdk/launch-form";
import type { WalletSender } from "./wallet-sender";

/** pump.fun fixed supply: 1,000,000,000 tokens × 10^6 decimals. */
const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;

/** Friendly step labels for the progress UI, keyed by the plan group label. */
const STEP_LABELS: Record<string, string> = {
  "create-treasury": "Create treasury",
  "create-token": "Create coin",
  "create-dao:council": "Create council",
  "create-dao:realm": "Create realm",
  "create-dao:governance": "Create governance",
  "create-dao:gate": "Initialize gate",
  "prefund-treasury": "Prefund treasury",
  "collect-launch-fee": "Collect launch fee",
};

export interface LaunchInput {
  mode: GovernanceMode;
  tier: MarketCapTier;
  params: GovernanceParams;
  metadata: { name: string; symbol: string; uri: string };
  devBuyLamports?: bigint;
  council?: { members: string[]; vetoThresholdPercent: number };
  launchFee?: { treasury: string; lamports: bigint };
  /**
   * Opt-in DEX-paid bounty (enhanced listing, D-036), set pre-launch. NO funds
   * move at launch: the DAO just COMMITS to the listing content (hashed here). A
   * community member later pays DEX Screener and is reimbursed in USDC by a DAO
   * vote — no per-launch cap (the listing is a fixed-price product). Purely
   * additive — it does not touch the on-chain launch plan.
   */
  enhancedListing?: { content: EnhancedListingContent };
  /**
   * TEST ONLY (gated behind NEXT_PUBLIC_TEST_MODE): shorten the community voting
   * window so a mainnet smoke test finalizes in minutes, not the 3-day default.
   */
  baseVotingTimeSeconds?: number;
  /**
   * TEST ONLY: set the exact proposal-threshold token count (raw, 6dp) instead
   * of the tier %-of-supply floor, so a tiny holding can create proposals.
   */
  proposalThresholdTokensOverride?: bigint;
  /**
   * TEST ONLY (D-014): cap the max community vote weight at this absolute amount
   * (raw, 6dp), so quorum % is taken against it instead of the full supply — a
   * ~$1 holding can then meet quorum and pass a proposal.
   */
  communityMaxVoteWeightAbsoluteRaw?: bigint;
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
  multisig: string;
  nativeTreasury: string;
  signatures: string[];
  /**
   * Present iff the launch set a DEX-paid bounty (D-036). The commitment is
   * what the later reimbursement claim/vote is checked against (the USDC payout
   * amount is the doer's verified DEX Screener payment, bounded by the protocol
   * known-cost ceiling — there is no per-launch cap).
   */
  enhancedListing?: { contentCommitment: string };
}

/** Real-supply proposal threshold (the form preview uses a placeholder supply). */
function realParams(input: LaunchInput): GovernanceParams {
  // TEST ONLY: an explicit tiny threshold so a small holding can propose.
  if (input.proposalThresholdTokensOverride !== undefined) {
    return {
      ...input.params,
      proposalThresholdTokens:
        input.proposalThresholdTokensOverride > 0n
          ? input.proposalThresholdTokensOverride
          : 1n,
    };
  }
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
  // council + guarded both seat a council mint (guarded adds the gate's H+1 seat).
  const councilMint =
    input.mode === "council" || input.mode === "guarded"
      ? Keypair.generate()
      : undefined;
  const { vaultPda } = deriveTreasuryPdas(createKey.publicKey);
  const params = realParams(input);

  // The pump create_v2 instructions — creator MUST be the vault PDA (INV-1).
  const rail = new PumpFunRail(connection);
  const createTokenIxs = await rail.buildCreateTokenIxs(
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

  const council =
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

  const programConfigTreasury = await fetchProgramConfigTreasury(connection);
  const plan = await buildLaunchPlan({
    launcher: wallet,
    mint: mint.publicKey,
    createKey: createKey.publicKey,
    mode: input.mode,
    params,
    createTokenIxs,
    programConfigTreasury,
    ...(council ? { council } : {}),
    ...(input.launchFee && input.launchFee.lamports > 0n
      ? {
          protocolTreasury: new PublicKey(input.launchFee.treasury),
          launchFeeLamports: input.launchFee.lamports,
        }
      : {}),
    ...(input.baseVotingTimeSeconds !== undefined
      ? { baseVotingTimeSeconds: input.baseVotingTimeSeconds }
      : {}),
    ...(input.communityMaxVoteWeightAbsoluteRaw !== undefined
      ? {
          communityMaxVoteWeightSource: absoluteMaxVoteWeight(
            input.communityMaxVoteWeightAbsoluteRaw,
          ),
        }
      : {}),
  });

  const keypairs = [mint, createKey, ...(councilMint ? [councilMint] : [])];
  const signatures: string[] = [];

  async function send(group: LaunchTxGroup): Promise<void> {
    const step = STEP_LABELS[group.label] ?? group.label;
    onStep({ step, status: "running" });
    try {
      const extra = extraSignersFor(group, keypairs);
      const tx = new Transaction().add(...group.instructions);
      tx.feePayer = wallet;
      tx.recentBlockhash = (
        await connection.getLatestBlockhash("confirmed")
      ).blockhash;
      if (extra.length) tx.partialSign(...extra);
      const sig = await sender.signAndSend(tx, connection);
      await connection.confirmTransaction(sig, "confirmed");
      signatures.push(sig);
      onStep({ step, status: "done", signature: sig });
    } catch (e) {
      onStep({ step, status: "error", error: (e as Error).message });
      throw e;
    }
  }

  for (const group of plan.groups) {
    // AUDIT-D: the multi-tx launch reveals the mint — and thus the deterministic
    // realm PDA — before the realm exists. Abort LOUDLY if it was squatted in
    // the window, rather than letting create-realm fail cryptically.
    if (group.label === "create-dao:realm") {
      const squatter = await connection.getAccountInfo(plan.treasury.realm);
      if (squatter) {
        const msg =
          "A realm already exists at this DAO's derived address — possible front-run/squat. Restart with a fresh launch; do NOT continue funding this one.";
        onStep({ step: STEP_LABELS[group.label]!, status: "error", error: msg });
        throw new Error(msg);
      }
    }
    const t: TransactionInstruction[] = group.instructions;
    if (t.length === 0) continue;
    await send(group);
  }

  return {
    mint: mint.publicKey.toBase58(),
    realm: plan.treasury.realm.toBase58(),
    governance: plan.treasury.governance.toBase58(),
    vault: plan.treasury.vaultPda.toBase58(),
    multisig: plan.treasury.multisigPda.toBase58(),
    nativeTreasury: plan.treasury.nativeTreasury.toBase58(),
    signatures,
    ...(input.enhancedListing
      ? {
          enhancedListing: {
            contentCommitment: computeContentCommitment(
              input.enhancedListing.content,
            ),
          },
        }
      : {}),
  };
}
