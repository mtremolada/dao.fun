/**
 * Stage 0 verify-and-record (spec 13.3): every (verify)-marked PDA seed is
 * pinned here against the installed package source as oracle. Findings are
 * recorded in DECISIONS.md. No network required.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ammCreatorVaultPda,
  creatorVaultPda,
  PUMP_AMM_PROGRAM_ID as SDK_PUMP_AMM_ID,
  PUMP_PROGRAM_ID as SDK_PUMP_ID,
  PUMP_FEE_PROGRAM_ID as SDK_PUMP_FEE_ID,
} from "@pump-fun/pump-sdk";
import { getNativeTreasuryAddress } from "@solana/spl-governance";
import { getVaultPda } from "@sqds/multisig";
import {
  PUMP_AMM_PROGRAM_ID,
  PUMP_FEES_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  SPL_GOVERNANCE_PROGRAM_ID,
  SQUADS_V4_PROGRAM_ID,
} from "../src/constants";
import {
  deriveGovernanceChainFromMint,
  deriveNativeTreasury,
  derivePumpAmmCreatorVaultAuthority,
  derivePumpCreatorVault,
  deriveRealm,
  realmNameForMint,
  REALM_NAME_LEN,
} from "../src/pda";

describe("program IDs match installed pump-sdk (verify)", () => {
  it("pump bonding curve", () => {
    expect(PUMP_PROGRAM_ID.equals(SDK_PUMP_ID)).toBe(true);
  });
  it("pump AMM", () => {
    expect(PUMP_AMM_PROGRAM_ID.equals(SDK_PUMP_AMM_ID)).toBe(true);
  });
  it("pump fees", () => {
    expect(PUMP_FEES_PROGRAM_ID.equals(SDK_PUMP_FEE_ID)).toBe(true);
  });
});

describe("pump creator vault PDAs (verify: hyphen vs underscore)", () => {
  const creator = Keypair.generate().publicKey;

  it("bonding-curve vault matches pump-sdk creatorVaultPda (hyphen seed)", () => {
    expect(derivePumpCreatorVault(creator).equals(creatorVaultPda(creator))).toBe(
      true,
    );
  });

  it("AMM vault authority matches pump-sdk ammCreatorVaultPda (underscore seed)", () => {
    expect(
      derivePumpAmmCreatorVaultAuthority(creator).equals(
        ammCreatorVaultPda(creator),
      ),
    ).toBe(true);
  });

  it("the two variants differ (regression guard against seed mixups)", () => {
    expect(
      derivePumpCreatorVault(creator).equals(
        derivePumpAmmCreatorVaultAuthority(creator),
      ),
    ).toBe(false);
  });
});

describe("SPL Governance PDAs (verify)", () => {
  it("native treasury matches spl-governance getNativeTreasuryAddress", async () => {
    const governance = Keypair.generate().publicKey;
    const oracle = await getNativeTreasuryAddress(
      SPL_GOVERNANCE_PROGRAM_ID,
      governance,
    );
    expect(deriveNativeTreasury(governance).equals(oracle)).toBe(true);
  });

  it("realm derivation uses ['governance', name]", () => {
    const name = "test-realm";
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from("governance"), Buffer.from(name)],
      SPL_GOVERNANCE_PROGRAM_ID,
    )[0];
    expect(deriveRealm(name).equals(expected)).toBe(true);
  });
});

describe("Squads v4 vault PDA (verify via @sqds/multisig getVaultPda)", () => {
  it("matches the SDK derivation for index 0", () => {
    const multisigPda = Keypair.generate().publicKey;
    const [oracle] = getVaultPda({
      multisigPda,
      index: 0,
      programId: SQUADS_V4_PROGRAM_ID,
    });
    const ours = PublicKey.findProgramAddressSync(
      [
        Buffer.from("multisig"),
        multisigPda.toBuffer(),
        Buffer.from("vault"),
        Buffer.from([0]),
      ],
      SQUADS_V4_PROGRAM_ID,
    )[0];
    expect(ours.equals(oracle)).toBe(true);
  });
});

describe("advance-derivation rule (spec Section 1, amended per DECISIONS.md D-001)", () => {
  it("full base58 mint pubkey exceeds max seed length — spec as written is impossible", () => {
    const mint = Keypair.generate().publicKey;
    // This documents WHY the amendment exists. If web3.js ever lifts the
    // 32-byte seed limit this test will flag it for re-evaluation.
    expect(() =>
      PublicKey.findProgramAddressSync(
        [Buffer.from("governance"), Buffer.from(mint.toBase58())],
        SPL_GOVERNANCE_PROGRAM_ID,
      ),
    ).toThrow(/Max seed length/);
  });

  it("realm name is the first 32 base58 chars of the mint", () => {
    const mint = Keypair.generate().publicKey;
    const name = realmNameForMint(mint);
    expect(name).toHaveLength(REALM_NAME_LEN);
    expect(mint.toBase58().startsWith(name)).toBe(true);
  });

  it("the full chain realm -> governance -> native treasury is computable from the mint alone, deterministically", () => {
    const mint = Keypair.generate().publicKey;
    const a = deriveGovernanceChainFromMint(mint);
    const b = deriveGovernanceChainFromMint(mint);
    expect(a.realm.equals(b.realm)).toBe(true);
    expect(a.governance.equals(b.governance)).toBe(true);
    expect(a.nativeTreasury.equals(b.nativeTreasury)).toBe(true);
    // All three are distinct accounts
    expect(a.realm.equals(a.governance)).toBe(false);
    expect(a.governance.equals(a.nativeTreasury)).toBe(false);
  });

  it("distinct mints yield distinct chains (collision sanity)", () => {
    const a = deriveGovernanceChainFromMint(Keypair.generate().publicKey);
    const b = deriveGovernanceChainFromMint(Keypair.generate().publicKey);
    expect(a.nativeTreasury.equals(b.nativeTreasury)).toBe(false);
  });
});
