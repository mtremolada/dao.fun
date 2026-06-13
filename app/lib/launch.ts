/**
 * Self-service (decentralized) launch flow — the browser half. NO server key,
 * no intermediary: the connected wallet is the launcher/fee-payer and signs
 * every group; the throwaway mint/createKey/councilMint keypairs are generated
 * HERE and co-sign. Mirrors the signing model proven on the real binaries by
 * tests/launch-plan-selfservice.integration.test.ts.
 *
 * Unlike the lean vote flow, the launch route legitimately needs chain deps
 * (key generation + tx building); Next.js code-splits this route so the
 * proposal/vote pages stay chain-dep-free.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  PumpFunRail,
  buildLaunchPlan,
  deriveTreasuryPdas,
  extraSignersFor,
  fetchProgramConfigTreasury,
  resolveGovernanceParams,
  type CouncilSetup,
  type GovernanceMode,
  type LaunchTxGroup,
  type MarketCapTier,
} from "@daofun/sdk";
import type { SignerLike } from "./governance-actions";
import { base64ToBytes, bytesToBase64 } from "./wallet-standard";

/** Every pump.fun token: 1e9 supply at 6 decimals (governance threshold input). */
const PUMP_TOTAL_SUPPLY = 1_000_000_000_000_000n;
/** SPL/Token-2022 base mint account size (no extensions) — used for council rent. */
const MINT_ACCOUNT_SIZE = 82;

export interface LaunchInput {
  rpcUrl: string;
  mode: GovernanceMode;
  tier: MarketCapTier;
  token: { name: string; symbol: string; uri: string; devBuyLamports?: bigint };
  sovereignHoldUpSeconds?: number;
  council?: { members: string[]; vetoThresholdPercent: number };
  /** Operator fee recipient + amount. Omit / 0 for a fully fee-free deploy. */
  protocolTreasury?: string;
  launchFeeLamports?: bigint;
}

export type LaunchPhase =
  | "preparing"
  | "signing"
  | "confirming"
  | "done"
  | "error";

export interface LaunchFlowState {
  phase: LaunchPhase;
  /** Current group label while signing/confirming. */
  step?: string;
  /** Confirmed group labels, in order. */
  completed: string[];
  signatures: string[];
  mint?: string;
  realm?: string;
  /** Squads vault + multisig — for linking straight to the DAO dashboard. */
  vault?: string;
  multisigPda?: string;
  error?: string;
}

export interface LaunchFlowOpts {
  signer: SignerLike;
  onState?: (s: LaunchFlowState) => void;
  /** Injectable for tests; defaults to a Connection on input.rpcUrl. */
  connection?: Connection;
}

async function signSubmitConfirm(
  connection: Connection,
  group: LaunchTxGroup,
  launcher: PublicKey,
  ephemerals: Keypair[],
  signer: SignerLike,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...group.instructions);
  tx.feePayer = launcher;
  tx.recentBlockhash = blockhash;
  // Co-sign with exactly the ephemeral keypairs this group needs…
  const extra = extraSignersFor(group, ephemerals);
  if (extra.length > 0) tx.partialSign(...extra);
  // …then the wallet adds its signature over the partially-signed bytes.
  const unsigned = bytesToBase64(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  );
  const signed = await signer.signTransaction(unsigned);
  const sig = await connection.sendRawTransaction(base64ToBytes(signed), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return sig;
}

/**
 * Drive a full self-service launch. Resolves when the DAO is stood up (or on
 * the first failing group — which, by the F-3 fee-last ordering, is always
 * BEFORE the launch fee is charged). On failure, restart with a fresh launch
 * (new ephemeral keypairs); the abandoned half-state is pre-fee and cheap.
 */
export async function launchFlow(
  input: LaunchInput,
  opts: LaunchFlowOpts,
): Promise<LaunchFlowState> {
  const state: LaunchFlowState = {
    phase: "preparing",
    completed: [],
    signatures: [],
  };
  const emit = () => opts.onState?.({ ...state });
  emit();

  try {
    const connection =
      opts.connection ?? new Connection(input.rpcUrl, "confirmed");
    const launcher = new PublicKey(signerAddress(opts.signer));

    const mintKp = Keypair.generate();
    const createKeyKp = Keypair.generate();
    const councilMintKp = Keypair.generate();
    const ephemerals = [mintKp, createKeyKp, councilMintKp];

    const params = resolveGovernanceParams({
      mode: input.mode,
      tier: input.tier,
      communitySupply: PUMP_TOTAL_SUPPLY,
      ...(input.sovereignHoldUpSeconds !== undefined
        ? { sovereignHoldUpSeconds: input.sovereignHoldUpSeconds }
        : {}),
    });

    const { vaultPda } = deriveTreasuryPdas(createKeyKp.publicKey);
    const rail = new PumpFunRail(connection);
    const createTokenIxs = await rail.buildCreateTokenIxs(
      {
        metadata: input.token,
        daoConfig: { mode: input.mode, marketCapTier: input.tier },
        rail: "pumpfun",
        launcher,
        ...(input.token.devBuyLamports
          ? { devBuyLamports: input.token.devBuyLamports }
          : {}),
      },
      vaultPda, // INV-1: creator == the Squads vault PDA
      mintKp,
    );

    const council: CouncilSetup | undefined =
      input.mode === "council" && input.council
        ? {
            mint: councilMintKp.publicKey,
            members: input.council.members.map((m) => new PublicKey(m)),
            vetoThresholdPercent: input.council.vetoThresholdPercent,
            mintRentLamports: BigInt(
              await connection.getMinimumBalanceForRentExemption(
                MINT_ACCOUNT_SIZE,
              ),
            ),
          }
        : undefined;

    const plan = await buildLaunchPlan({
      launcher,
      mint: mintKp.publicKey,
      createKey: createKeyKp.publicKey,
      mode: input.mode,
      params,
      createTokenIxs,
      programConfigTreasury: await fetchProgramConfigTreasury(connection),
      ...(input.protocolTreasury
        ? { protocolTreasury: new PublicKey(input.protocolTreasury) }
        : {}),
      ...(input.launchFeeLamports !== undefined
        ? { launchFeeLamports: input.launchFeeLamports }
        : {}),
      ...(council ? { council } : {}),
    });
    state.mint = plan.mint.toBase58();
    state.realm = plan.treasury.realm.toBase58();
    state.vault = plan.treasury.vaultPda.toBase58();
    state.multisigPda = plan.treasury.multisigPda.toBase58();

    for (const group of plan.groups) {
      // AUDIT-D: realm-squat / launch front-run guard. create-token reveals the
      // mint on-chain; the realm name derives from it; an attacker watching the
      // mempool could createRealm at the derived address before our create-dao
      // lands (a wider window here because each tx is a separate wallet popup).
      // Fail fast with a clear, actionable error rather than a cryptic revert.
      // (The hijack variant — a malicious squatted governance — is caught for
      // buyers by verifyDao's structural + config risk checks.)
      if (group.label === "create-dao:realm") {
        const existing = await connection.getAccountInfo(plan.treasury.realm);
        if (existing) {
          throw new Error(
            "realm already exists at the derived address — possible launch front-run/squat. " +
              "Restart with a fresh launch (new keys); do NOT fund this one.",
          );
        }
      }
      state.phase = "signing";
      state.step = group.label;
      emit();
      const sig = await signSubmitConfirm(
        connection,
        group,
        launcher,
        ephemerals,
        opts.signer,
      );
      state.phase = "confirming";
      emit();
      state.completed.push(group.label);
      state.signatures.push(sig);
    }

    state.phase = "done";
    delete state.step;
    emit();
    return state;
  } catch (e) {
    state.phase = "error";
    state.error = (e as Error).message;
    emit();
    return state;
  }
}

function signerAddress(signer: SignerLike): string {
  if (!signer.address) throw new Error("connect a wallet first");
  return signer.address;
}
