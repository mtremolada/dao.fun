/**
 * Spec 6.2 — Treasury (Squads, single-member design). Written before
 * implementation. Unit-level: instruction structure + PDA properties.
 * On-chain rejection tests (non-member cannot act; raw transfer fails) are
 * integration suites at Stage 1 GATE 1 (need a validator with clones).
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import {
  buildCreateTreasuryIx,
  deriveTreasuryPdas,
} from "../src/treasury";

const payer = Keypair.generate().publicKey;
const predicted = Keypair.generate().publicKey; // predicted native-treasury PDA
const createKey = Keypair.generate().publicKey;
const programConfigTreasury = Keypair.generate().publicKey;

function build() {
  return buildCreateTreasuryIx({
    payer,
    predictedNativeTreasury: predicted,
    createKey,
    programConfigTreasury,
  });
}

describe("deriveTreasuryPdas", () => {
  it("matches @sqds/multisig getMultisigPda/getVaultPda oracles", () => {
    const { multisigPda, vaultPda } = deriveTreasuryPdas(createKey);
    const [expectedMs] = multisig.getMultisigPda({ createKey });
    const [expectedVault] = multisig.getVaultPda({
      multisigPda: expectedMs,
      index: 0,
    });
    expect(multisigPda.equals(expectedMs)).toBe(true);
    expect(vaultPda.equals(expectedVault)).toBe(true);
  });

  it("vault PDA satisfies pump creator constraints: not default, off-curve", () => {
    const { vaultPda } = deriveTreasuryPdas(createKey);
    expect(vaultPda.equals(PublicKey.default)).toBe(false);
    expect(PublicKey.isOnCurve(vaultPda.toBytes())).toBe(false);
  });
});

describe("buildCreateTreasuryIx (INV-7 from the first instruction)", () => {
  it("members == [predicted native treasury] with full permissions, threshold 1", () => {
    const { ix } = build();
    const [decoded] = multisig.generated.multisigCreateV2Struct.deserialize(
      ix.data,
    );
    const args = decoded.args;
    expect(args.threshold).toBe(1);
    expect(args.members).toHaveLength(1);
    expect(new PublicKey(args.members[0]!.key).equals(predicted)).toBe(true);
    // Propose | Vote | Execute == mask 7 (Permissions.all())
    expect(args.members[0]!.permissions.mask).toBe(7);
  });

  it("config is final: configAuthority null, timeLock 0; rentCollector is the native treasury (D-016)", () => {
    const { ix } = build();
    const [decoded] = multisig.generated.multisigCreateV2Struct.deserialize(
      ix.data,
    );
    expect(decoded.args.configAuthority).toBeNull();
    expect(decoded.args.timeLock).toBe(0);
    // D-016: execution rent locked in Squads Transaction/Proposal accounts
    // flows back to the DAO when they are closed — never to a platform key.
    expect(decoded.args.rentCollector).not.toBeNull();
    expect(new PublicKey(decoded.args.rentCollector!).equals(predicted)).toBe(
      true,
    );
  });

  it("createKey signs; the predicted PDA does NOT sign (it cannot)", () => {
    const { ix } = build();
    const createKeyMeta = ix.keys.find((k) => k.pubkey.equals(createKey));
    expect(createKeyMeta?.isSigner).toBe(true);
    for (const meta of ix.keys) {
      if (meta.pubkey.equals(predicted)) {
        expect(meta.isSigner).toBe(false);
      }
    }
  });

  it("returned PDAs equal the derivation helpers (no drift)", () => {
    const { multisigPda, vaultPda } = build();
    const derived = deriveTreasuryPdas(createKey);
    expect(multisigPda.equals(derived.multisigPda)).toBe(true);
    expect(vaultPda.equals(derived.vaultPda)).toBe(true);
  });
});
