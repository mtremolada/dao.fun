/**
 * Production launch wiring — turns a validated LaunchFormInput into the
 * concrete step machine (buildLaunchSteps) backed by a real Connection.
 *
 * Key custody (spec Section 11): the LAUNCHER keypair is the only
 * persistent secret the server holds — it pays gas + the flat launch fee
 * and is the pump `user` signer. The mint / createKey / council-mint
 * keypairs are EPHEMERAL: generated per launch and kept in-memory for the
 * (possibly resumed) duration. They sign only account-creation
 * instructions for accounts that become immutable or authority-null in
 * the same ceremony, so their loss after completion is harmless. They are
 * NEVER written to disk or logged.
 *
 * This is the agent/operator-launch path (backend-orchestrated). A future
 * fully-browser launch would move launcher signing to the wallet; the
 * step machine is identical either way.
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import * as multisig from "@sqds/multisig";
import {
  PumpFunRail,
  SQUADS_V4_PROGRAM_ID,
  fetchProgramConfigTreasury,
  gateSeatCouncilTokens,
  guardedVetoPercent,
  resolveGovernanceParams,
  type CouncilSetup,
  type LaunchParams,
  type LaunchResult,
} from "@daofun/sdk";
import {
  TREASURY_EXECUTION_PREFUND_LAMPORTS,
  buildLaunchSteps,
  type LaunchStepDeps,
} from "./launch-steps";
import type { LaunchStep } from "./launch-machine";
import type { LaunchFormInput } from "@daofun/sdk";

export interface LaunchServiceConfig {
  connection: Connection;
  /** Pays gas + launch fee; the pump `user` signer (Section 11). */
  launcher: Keypair;
  protocolTreasury: PublicKey;
  launchFeeLamports: bigint;
  /** Rent-exempt lamports for a council MINT_SIZE account; fetch once at
   * boot (getMinimumBalanceForRentExemption(82)) so buildSteps stays sync.
   * Only used in council/guarded launches. */
  councilMintRentLamports: bigint;
  computeUnitLimit?: number;
  priorityMicroLamports?: number;
}

/** In-memory per-launch ephemeral keypair custody (see file header). */
interface LaunchKeys {
  mint: Keypair;
  createKey: Keypair;
  councilMint: Keypair;
}

export class LaunchService {
  private readonly rail: PumpFunRail;
  private readonly keysByLaunch = new Map<string, LaunchKeys>();
  private programConfigTreasury: PublicKey | undefined;

  constructor(private readonly cfg: LaunchServiceConfig) {
    this.rail = new PumpFunRail(cfg.connection);
  }

  /** createApiHandler buildSteps seam. */
  buildSteps = (launchId: string, form: LaunchFormInput): LaunchStep[] => {
    const keys = this.keysFor(launchId);
    const supply = 1_000_000_000n; // pump fixed initial supply (6 decimals)
    const params = resolveGovernanceParams({
      mode: form.mode,
      tier: form.tier,
      communitySupply: supply,
      ...(form.sovereignHoldUpSeconds !== undefined
        ? { sovereignHoldUpSeconds: form.sovereignHoldUpSeconds }
        : {}),
    });

    const needsCouncil = form.mode === "council" || form.mode === "guarded";
    const council: CouncilSetup | undefined = needsCouncil
      ? {
          mint: keys.councilMint.publicKey,
          members: (form.councilMembers ?? []).map((m) => new PublicKey(m)),
          // The form/SDK store the NOMINAL human percent; buildCreateDaoIxs
          // adjusts for the gate seat in guarded mode. For council it is
          // used verbatim; we pass nominal and let the builder decide.
          vetoThresholdPercent: form.councilVetoThresholdPercent ?? 50,
          mintRentLamports: this.cfg.councilMintRentLamports,
        }
      : undefined;

    const launchParams: LaunchParams = {
      metadata: form.metadata ?? { name: "", symbol: "", uri: "" },
      daoConfig: {
        mode: form.mode,
        marketCapTier: form.tier,
        ...(council ? { councilMembers: council.members } : {}),
        ...(form.councilVetoThresholdPercent !== undefined
          ? { councilVetoThresholdPercent: form.councilVetoThresholdPercent }
          : {}),
        ...(form.sovereignHoldUpSeconds !== undefined
          ? { sovereignHoldUpSeconds: form.sovereignHoldUpSeconds }
          : {}),
      },
      rail: "pumpfun",
      launcher: this.cfg.launcher.publicKey,
    };

    const { steps } = buildLaunchSteps(
      {
        mint: keys.mint.publicKey,
        createKey: keys.createKey.publicKey,
        launcher: this.cfg.launcher.publicKey,
        protocolTreasury: this.cfg.protocolTreasury,
        launchFeeLamports: this.cfg.launchFeeLamports,
        daoMode: form.mode,
        governanceParams: params,
        launchParams,
        ...(council ? { council } : {}),
      },
      this.deps(launchId),
    );
    return steps;
  };

  /** Drop the ephemeral keys once a launch reaches a terminal state. */
  forget(launchId: string): void {
    this.keysByLaunch.delete(launchId);
  }

  private keysFor(launchId: string): LaunchKeys {
    let keys = this.keysByLaunch.get(launchId);
    if (!keys) {
      keys = {
        mint: Keypair.generate(),
        createKey: Keypair.generate(),
        councilMint: Keypair.generate(),
      };
      this.keysByLaunch.set(launchId, keys);
    }
    return keys;
  }

  private deps(launchId: string): LaunchStepDeps {
    const { connection } = this.cfg;
    const keys = this.keysFor(launchId);
    // Every ephemeral keypair is a potential signer; the launcher always is.
    const signerSet = [
      this.cfg.launcher,
      keys.mint,
      keys.createKey,
      keys.councilMint,
    ];

    return {
      sendAndConfirm: async (ixs: TransactionInstruction[], _label: string) => {
        const tx = new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: this.cfg.computeUnitLimit ?? 400_000,
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: this.cfg.priorityMicroLamports ?? 50_000,
          }),
          ...ixs,
        );
        tx.feePayer = this.cfg.launcher.publicKey;
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        // Sign only with the keypairs this tx actually requires.
        const msg = tx.compileMessage();
        const required = new Set(
          msg.accountKeys
            .slice(0, msg.header.numRequiredSignatures)
            .map((k) => k.toBase58()),
        );
        const signers = signerSet.filter((s) =>
          required.has(s.publicKey.toBase58()),
        );
        return sendAndConfirmTransaction(connection, tx, signers, {
          commitment: "confirmed",
        });
      },

      buildCreateTokenIxs: (params, creator, mint) => {
        // The deps seam passes the mint PUBKEY; the rail's create needs the
        // mint KEYPAIR (it co-signs account creation). Bridge via our
        // ephemeral custody, asserting they match.
        if (!mint.equals(keys.mint.publicKey)) {
          throw new Error("launch-service: mint pubkey mismatch with custody");
        }
        return this.rail.buildCreateTokenIxs(params, creator, keys.mint);
      },

      fetchProgramConfigTreasury: async () => {
        this.programConfigTreasury ??=
          await fetchProgramConfigTreasury(connection);
        return this.programConfigTreasury;
      },

      fetchMintAuthority: async (mint: PublicKey) => {
        const info = await getMint(connection, mint);
        return info.mintAuthority;
      },

      fetchMultisigSoleMember: async (
        multisigPda: PublicKey,
        expected: PublicKey,
      ) => {
        const ms = await multisig.accounts.Multisig.fromAccountAddress(
          connection,
          multisigPda,
        );
        if (ms.members.length !== 1) {
          throw new Error(
            `multisig ${multisigPda.toBase58()} has ${ms.members.length} members, expected sole member`,
          );
        }
        const member = ms.members[0]!.key;
        if (!member.equals(expected)) {
          throw new Error(
            `multisig sole member ${member.toBase58()} != predicted ${expected.toBase58()}`,
          );
        }
        return member;
      },
    };
  }
}

// re-export so callers need one import surface
export {
  TREASURY_EXECUTION_PREFUND_LAMPORTS,
  gateSeatCouncilTokens,
  guardedVetoPercent,
  SQUADS_V4_PROGRAM_ID,
  type LaunchResult,
};
