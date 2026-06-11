/**
 * Treasury — spec 6.2. Squads v4 multisig whose SOLE member is the Realm's
 * governance native-treasury PDA (threshold 1). No human key is ever in the
 * custody path (INV-7); the vault PDA (index 0) is the pump `creator`
 * (INV-1). Config is final at creation: configAuthority null, no MVP
 * config-change path.
 */
import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

export interface CreateTreasuryParams {
  /** Rent payer / creation fee payer (the launcher). */
  payer: PublicKey;
  /** Advance-derived native-treasury PDA (deriveGovernanceChainFromMint). */
  predictedNativeTreasury: PublicKey;
  /** Ephemeral keypair pubkey; must co-sign the creation tx. */
  createKey: PublicKey;
  /** Squads program-config treasury (fetchProgramConfigTreasury). */
  programConfigTreasury: PublicKey;
}

export function deriveTreasuryPdas(createKey: PublicKey): {
  multisigPda: PublicKey;
  vaultPda: PublicKey;
} {
  const [multisigPda] = multisig.getMultisigPda({ createKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
  return { multisigPda, vaultPda };
}

export async function fetchProgramConfigTreasury(
  connection: Connection,
): Promise<PublicKey> {
  const [programConfigPda] = multisig.getProgramConfigPda({});
  const config = await multisig.accounts.ProgramConfig.fromAccountAddress(
    connection,
    programConfigPda,
  );
  return config.treasury;
}

export function buildCreateTreasuryIx(params: CreateTreasuryParams): {
  ix: TransactionInstruction;
  multisigPda: PublicKey;
  vaultPda: PublicKey;
} {
  const { multisigPda, vaultPda } = deriveTreasuryPdas(params.createKey);
  const ix = multisig.instructions.multisigCreateV2({
    treasury: params.programConfigTreasury,
    creator: params.payer,
    multisigPda,
    configAuthority: null, // final at creation — nothing to change (spec 6.2)
    threshold: 1,
    members: [
      {
        key: params.predictedNativeTreasury,
        permissions: multisig.types.Permissions.all(),
      },
    ],
    timeLock: 0,
    createKey: params.createKey,
    rentCollector: null,
  });
  return { ix, multisigPda, vaultPda };
}
