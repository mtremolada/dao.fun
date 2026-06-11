/**
 * Spec 6.8 — fixed action menu builders (written before implementation).
 * MVP scope here: `grant` and `burn` — the two actions whose dependencies
 * are fully verified. buyback/provideLiquidity/distribute/setParam land
 * once their (verify) items resolve (PumpSwap pool ixs, merkle distributor
 * ID, param registry). Each builder asserts its bounds and touches no
 * accounts outside the declared set.
 */
import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { buildGrantIxs, buildBurnIxs } from "../src/actions";

const vault = Keypair.generate().publicKey;
const recipient = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;

describe("grant (single transfer <= vault balance)", () => {
  it("builds exactly one SystemProgram transfer from the vault", () => {
    const ixs = buildGrantIxs({
      vault,
      recipient,
      lamports: 1_000_000n,
      vaultBalanceLamports: 2_000_000n,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix.keys[0]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[1]!.pubkey.equals(recipient)).toBe(true);
    // no accounts outside the declared set
    expect(ix.keys).toHaveLength(2);
  });

  it("rejects amounts exceeding the vault balance or zero", () => {
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 6_000n,
        vaultBalanceLamports: 5_000n,
      }),
    ).toThrow(/exceeds vault balance/);
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 0n,
        vaultBalanceLamports: 5_000n,
      }),
    ).toThrow(/positive/);
  });

  it("rejects grants that would push the vault below the rent floor", () => {
    expect(() =>
      buildGrantIxs({
        vault,
        recipient,
        lamports: 4_500n,
        vaultBalanceLamports: 5_000n,
        rentFloorLamports: 890_880n,
      }),
    ).toThrow(/rent floor/);
  });
});

describe("burn (treasury-held tokens only)", () => {
  it("burns from the vault's own ATA with the vault as authority", () => {
    const ixs = buildBurnIxs({
      vault,
      mint,
      amount: 42n,
      vaultTokenBalance: 100n,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });
    expect(ixs).toHaveLength(1);
    const ix = ixs[0]!;
    expect(ix.programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // burn accounts: [account, mint, authority]
    expect(ix.keys[1]!.pubkey.equals(mint)).toBe(true);
    expect(ix.keys[2]!.pubkey.equals(vault)).toBe(true);
    expect(ix.keys[2]!.isSigner).toBe(true); // vault invoke_signs via Squads
  });

  it("rejects burning more than the treasury holds, or zero", () => {
    expect(() =>
      buildBurnIxs({
        vault,
        mint,
        amount: 101n,
        vaultTokenBalance: 100n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
    ).toThrow(/exceeds treasury balance/);
    expect(() =>
      buildBurnIxs({
        vault,
        mint,
        amount: 0n,
        vaultTokenBalance: 100n,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }),
    ).toThrow(/positive/);
  });
});
