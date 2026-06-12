/**
 * Concrete launch steps — spec 6.6, executing the Section 2 sequence over
 * the step machine:
 *
 *   create-treasury     Squads multisig, sole member = predicted PDA (INV-7)
 *   collect-launch-fee  launcher -> protocol treasury, exact lamports
 *   create-token        pump create, creator = vault PDA (INV-1)
 *   create-dao          council mint first -> realm + VSR -> governance
 *   prefund-treasury    native treasury rent floor + Squads execution
 *                       rent headroom (D-016)
 *   assert-invariants   INV-5 (mint authority null), INV-7 (sole member),
 *                       predictedPdasMatched — failure HALTS, never improvises
 *
 * Chain access is injected (LaunchStepDeps) so this logic is unit-tested
 * offline; the wiring to a real Connection lives with the API layer.
 * Keypair custody note: the mint/createKey/council-mint keypairs must be
 * held by the caller for the duration of a (possibly resumed) launch; only
 * their pubkeys appear here.
 */
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import {
  buildCreateDaoIxs,
  buildCreateTreasuryIx,
  deriveGovernanceChainFromMint,
  deriveTreasuryPdas,
  type CouncilSetup,
  type GovernanceMode,
  type GovernanceParams,
  type LaunchParams,
  type LaunchResult,
  type TreasuryRef,
} from "@daofun/sdk";
import type { LaunchStep } from "./launch-machine";

/**
 * D-016, measured live on mainnet: when governance executes the wrapped
 * Squads chain, the native treasury pays rent for the accounts Squads
 * creates — VaultTransactionCreate 2,429,040 + ProposalCreate 2,046,240
 * lamports for a 1-instruction sweep — on top of its own 890,880 floor.
 * Prefund the floor plus headroom for one execution; rent returns to the
 * treasury when the Squads accounts close (rentCollector, spec 6.2).
 */
export const TREASURY_EXECUTION_PREFUND_LAMPORTS = 6_000_000;

export interface LaunchStepDeps {
  /** Sends ixs (with tx hygiene) signed by the wallet set the API holds. */
  sendAndConfirm(
    ixs: TransactionInstruction[],
    label: string,
  ): Promise<string>;
  /** Rail seam (INV-1 is asserted on what this gets called with). */
  buildCreateTokenIxs(
    params: LaunchParams,
    creator: PublicKey,
    mint: PublicKey,
  ): Promise<TransactionInstruction[]>;
  fetchProgramConfigTreasury(): Promise<PublicKey>;
  /** Returns the mint authority, or null if revoked (INV-5 wants null). */
  fetchMintAuthority(mint: PublicKey): Promise<PublicKey | null>;
  /**
   * Returns the multisig's sole member iff it has exactly one; implementations
   * should throw or return a non-matching key otherwise.
   */
  fetchMultisigSoleMember(
    multisigPda: PublicKey,
    expected: PublicKey,
  ): Promise<PublicKey>;
}

export interface LaunchStepArgs {
  mint: PublicKey;
  createKey: PublicKey;
  launcher: PublicKey;
  protocolTreasury: PublicKey;
  launchFeeLamports: bigint;
  daoMode: GovernanceMode;
  governanceParams: GovernanceParams;
  launchParams: LaunchParams;
  council?: CouncilSetup;
}

export function buildLaunchSteps(
  args: LaunchStepArgs,
  deps: LaunchStepDeps,
): { steps: LaunchStep[]; getResult: () => LaunchResult | null } {
  const predicted = deriveGovernanceChainFromMint(args.mint);
  const { multisigPda, vaultPda } = deriveTreasuryPdas(args.createKey);
  const txSignatures: string[] = [];
  let result: LaunchResult | null = null;

  async function send(ixs: TransactionInstruction[], label: string) {
    const sig = await deps.sendAndConfirm(ixs, label);
    txSignatures.push(sig);
    return sig;
  }

  const steps: LaunchStep[] = [
    {
      name: "create-treasury",
      async run() {
        const { ix } = buildCreateTreasuryIx({
          payer: args.launcher,
          predictedNativeTreasury: predicted.nativeTreasury,
          createKey: args.createKey,
          programConfigTreasury: await deps.fetchProgramConfigTreasury(),
        });
        return [await send([ix], "create-treasury")];
      },
    },
    {
      name: "create-token",
      async run() {
        const ixs = await deps.buildCreateTokenIxs(
          args.launchParams,
          vaultPda, // INV-1: the creator is the vault PDA, set in-instruction
          args.mint,
        );
        return [await send(ixs, "create-token")];
      },
    },
    {
      name: "create-dao",
      async run() {
        const dao = await buildCreateDaoIxs({
          mint: args.mint,
          payer: args.launcher,
          mode: args.daoMode,
          params: args.governanceParams,
          ...(args.council ? { council: args.council } : {}),
          // pump create_v2 mints are always Token-2022 (D-004); this makes the
          // builder drop the VSR addin and retarget the realm/governance
          // instructions so create-dao can actually execute (AUDIT F-1).
          communityTokenProgram: TOKEN_2022_PROGRAM_ID,
        });
        const sigs = [await send(dao.groups.realmSetup, "create-dao:realm")];
        if (dao.groups.council.length > 0) {
          sigs.push(await send(dao.groups.council, "create-dao:council"));
        }
        sigs.push(await send(dao.groups.governanceSetup, "create-dao:governance"));

        if (!dao.nativeTreasury.equals(predicted.nativeTreasury)) {
          throw new Error(
            "advance-derivation mismatch: built native treasury != prediction",
          );
        }
        return sigs;
      },
    },
    {
      name: "prefund-treasury",
      async run() {
        const ix = SystemProgram.transfer({
          fromPubkey: args.launcher,
          toPubkey: predicted.nativeTreasury,
          lamports: TREASURY_EXECUTION_PREFUND_LAMPORTS,
        });
        return [await send([ix], "prefund-treasury")];
      },
    },
    {
      // AUDIT F-3: charge the launch fee only AFTER the DAO and its treasury
      // exist, so a failed create-dao (e.g. a builder/RPC error) never debits
      // the launcher for an ungovernable token. The fee step changes no
      // governance state, so running it here keeps the dangerous partial
      // states pre-fee.
      name: "collect-launch-fee",
      async run() {
        const ix = SystemProgram.transfer({
          fromPubkey: args.launcher,
          toPubkey: args.protocolTreasury,
          lamports: args.launchFeeLamports,
        });
        return [await send([ix], "collect-launch-fee")];
      },
    },
    {
      name: "assert-invariants",
      async run() {
        const mintAuthority = await deps.fetchMintAuthority(args.mint);
        if (mintAuthority !== null) {
          throw new Error(
            `INV-5 violated: mint authority is ${mintAuthority.toBase58()}, expected null`,
          );
        }
        const soleMember = await deps.fetchMultisigSoleMember(
          multisigPda,
          predicted.nativeTreasury,
        );
        if (!soleMember.equals(predicted.nativeTreasury)) {
          throw new Error(
            "INV-7 violated: multisig sole member is not the predicted native treasury",
          );
        }
        const treasury: TreasuryRef = {
          multisigPda,
          vaultPda,
          realm: predicted.realm,
          governance: predicted.governance,
          nativeTreasury: predicted.nativeTreasury,
        };
        result = {
          mint: args.mint,
          treasury,
          mode: args.daoMode,
          txSignatures: [...txSignatures],
          mintAuthorityNull: true,
          predictedPdasMatched: true,
        };
        return []; // assertion step sends no transactions
      },
    },
  ];

  return { steps, getResult: () => result };
}
