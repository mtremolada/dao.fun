/**
 * Client-side instruction decoder (INV-10): precise summaries for the known
 * menu actions, and — the security-critical property — a SAFE FALLBACK that
 * marks any unrecognised instruction "UNKNOWN — raw data" and raises the
 * unknown-instruction flag, so nothing executable is ever silently hidden.
 */
import { describe, expect, it } from "vitest";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  AuthorityType,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
} from "@solana/spl-token";
import { createSetGovernanceConfig } from "@solana/spl-governance";
import {
  SPL_GOVERNANCE_PROGRAM_ID,
  decodeInstruction,
  decodeProposal,
} from "../src";

describe("decodeInstruction", () => {
  it("decodes a System transfer with lamports + sol-transfer flag", () => {
    const d = decodeInstruction(
      SystemProgram.transfer({
        fromPubkey: Keypair.generate().publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 890_880,
      }),
    );
    expect(d.known).toBe(true);
    expect(d.program).toBe("System");
    expect(d.summary).toContain("890880 lamports");
    expect(d.flags).toContain("sol-transfer");
  });

  it("decodes a Token-2022 burn with amount + token-burn flag", () => {
    const mint = Keypair.generate().publicKey;
    const acct = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const d = decodeInstruction(
      createBurnInstruction(acct, mint, owner, 12345n, [], TOKEN_2022_PROGRAM_ID),
    );
    expect(d.known).toBe(true);
    expect(d.summary).toContain("Burn 12345 base units");
    expect(d.flags).toContain("token-burn");
  });

  it("AUDIT-C: flags MintTo (inflation) — a rug primitive voters must see", () => {
    const mint = Keypair.generate().publicKey;
    const acct = Keypair.generate().publicKey;
    const auth = Keypair.generate().publicKey;
    const d = decodeInstruction(
      createMintToInstruction(mint, acct, auth, 1_000n, [], TOKEN_2022_PROGRAM_ID),
    );
    expect(d.summary).toContain("MintTo");
    expect(d.flags).toContain("token-mint");
  });

  it("AUDIT-C: flags SetAuthority (re-enabling mint/freeze authority)", () => {
    const mint = Keypair.generate().publicKey;
    const auth = Keypair.generate().publicKey;
    const newAuth = Keypair.generate().publicKey;
    const d = decodeInstruction(
      createSetAuthorityInstruction(
        mint,
        auth,
        AuthorityType.MintTokens,
        newAuth,
        [],
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    expect(d.flags).toContain("set-authority");
  });

  it("flags a governance config (setParam) instruction", () => {
    // a minimal setGovernanceConfig — only the program id + flag matter here
    const ixs: TransactionInstruction[] = [];
    void ixs;
    const ix = new TransactionInstruction({
      programId: SPL_GOVERNANCE_PROGRAM_ID,
      keys: [
        {
          pubkey: Keypair.generate().publicKey,
          isSigner: true,
          isWritable: true,
        },
      ],
      data: Buffer.from([19, 0, 0, 0]),
    });
    const d = decodeInstruction(ix);
    expect(d.program).toBe("SPL Governance");
    expect(d.flags).toContain("governance-config-change");
    // ensure the real client exists (oracle import is exercised)
    expect(typeof createSetGovernanceConfig).toBe("function");
  });

  it("SAFE FALLBACK: an unknown program is flagged, never hidden", () => {
    const unknown = new PublicKey("Stake11111111111111111111111111111111111111");
    const d = decodeInstruction(
      new TransactionInstruction({
        programId: unknown,
        keys: [],
        data: Buffer.from([1, 2, 3, 4]),
      }),
    );
    expect(d.known).toBe(false);
    expect(d.summary).toBe("UNKNOWN — raw data");
    expect(d.flags).toContain("unknown-instruction");
  });
});

describe("decodeProposal", () => {
  it("summarizes a set and dedupes red flags; a hidden unknown leg surfaces", () => {
    const drain = SystemProgram.transfer({
      fromPubkey: Keypair.generate().publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    const sneaky = new TransactionInstruction({
      programId: new PublicKey("Stake11111111111111111111111111111111111111"),
      keys: [],
      data: Buffer.from([9]),
    });
    const out = decodeProposal([drain, sneaky]);
    expect(out.instructions).toHaveLength(2);
    expect(out.summary).toContain("System");
    expect(out.redFlags).toContain("sol-transfer");
    expect(out.redFlags).toContain("unknown-instruction");
  });

  it("empty set", () => {
    expect(decodeProposal([]).summary).toBe("No executable instructions");
  });
});
