/**
 * Proposal-creation assembly (pure). The end-to-end execute is proven on the
 * real binaries in tests/propose-grant.integration.test.ts; here we pin the
 * grant bounds (D-009) and the group shape the browser sends.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { buildCreateGrantProposal } from "../src/proposal-create";

const pk = () => Keypair.generate().publicKey;

const base = () => ({
  realm: pk(),
  governance: pk(),
  governingTokenMint: pk(),
  nativeTreasury: pk(),
  multisig: pk(),
  vault: pk(),
  proposer: pk(),
  tokenOwnerRecord: pk(),
  recipient: pk(),
  lamports: 500_000_000n,
  vaultBalanceLamports: 2_000_000_000n,
  proposalIndex: 0,
  transactionIndex: 1n,
  holdUpSeconds: 72 * 3600,
  name: "grant",
});

describe("buildCreateGrantProposal", () => {
  it("assembles create / inserts / sign-off groups with a 64-hex artifact hash", async () => {
    const r = await buildCreateGrantProposal(base());
    expect(r.proposal).toBeDefined();
    expect(r.innerInstructionSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.groups.create.length).toBeGreaterThan(0);
    expect(r.groups.inserts.length).toBeGreaterThan(0);
    expect(r.groups.signOff.length).toBeGreaterThan(0);
    // one inserted ProposalTransaction per wrapped instruction
    expect(r.groups.inserts.length).toBe(r.wrapped.length);
  });

  it("enforces the grant bounds (D-009): positive, within balance, leaves the rent floor", async () => {
    await expect(
      buildCreateGrantProposal({ ...base(), lamports: 0n }),
    ).rejects.toThrow(/positive/);
    await expect(
      buildCreateGrantProposal({
        ...base(),
        lamports: 3_000_000_000n,
        vaultBalanceLamports: 2_000_000_000n,
      }),
    ).rejects.toThrow(/exceeds vault balance/);
    await expect(
      buildCreateGrantProposal({
        ...base(),
        lamports: 1_999_500_000n, // would leave < 890_880 behind
        vaultBalanceLamports: 2_000_000_000n,
      }),
    ).rejects.toThrow(/rent floor/);
  });
});
