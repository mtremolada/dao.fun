/**
 * Spec 6.3 — Governance (Realms + VSR + council). Written before
 * implementation. Unit-level: builder structure, PDA predictions, config
 * values, mode-structural differences. On-chain behavior (veto blocks
 * execution, clock-warped lockup weight) is the Stage 1 integration suite.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildCreateDaoIxs } from "../src/governance";
import { resolveGovernanceParams } from "../src/matrix";
import {
  deriveGovernanceChainFromMint,
  deriveVsrRegistrar,
} from "../src/pda";
import { SPL_GOVERNANCE_PROGRAM_ID, VSR_PROGRAM_ID } from "../src/constants";

const mint = Keypair.generate().publicKey;
const payer = Keypair.generate().publicKey;
const supply = 1_000_000_000n;

function cypherpunkDao() {
  return buildCreateDaoIxs({
    mint,
    payer,
    mode: "cypherpunk",
    params: resolveGovernanceParams({
      mode: "cypherpunk",
      tier: "micro",
      communitySupply: supply,
    }),
  });
}

function councilDao(members: PublicKey[], councilMint: PublicKey) {
  return buildCreateDaoIxs({
    mint,
    payer,
    mode: "council",
    params: resolveGovernanceParams({
      mode: "council",
      tier: "small",
      communitySupply: supply,
    }),
    council: {
      mint: councilMint,
      members,
      vetoThresholdPercent: 60,
      mintRentLamports: 1_461_600n,
    },
  });
}

describe("advance-derivation holds through the real builders", () => {
  it("realm/governance/native-treasury equal the mint-derived predictions", async () => {
    const dao = await cypherpunkDao();
    const predicted = deriveGovernanceChainFromMint(mint);
    expect(dao.realm.equals(predicted.realm)).toBe(true);
    expect(dao.governance.equals(predicted.governance)).toBe(true);
    expect(dao.nativeTreasury.equals(predicted.nativeTreasury)).toBe(true);
  });

  it("VSR registrar matches its derivation and createRegistrar targets VSR", async () => {
    const dao = await cypherpunkDao();
    expect(
      dao.registrar.equals(deriveVsrRegistrar(dao.realm, mint)),
    ).toBe(true);
    const vsrIxs = dao.ixs.filter((ix) => ix.programId.equals(VSR_PROGRAM_ID));
    expect(vsrIxs.length).toBe(2); // createRegistrar + configureVotingMint
    expect(vsrIxs[0]!.keys[0]!.pubkey.equals(dao.registrar)).toBe(true);
  });
});

describe("VSR min-lockup approximation (spec 6.3 note)", () => {
  it("configureVotingMint encodes baseline weight 0 and the tier saturation", async () => {
    const dao = await cypherpunkDao();
    const cfg = dao.ixs.filter((ix) => ix.programId.equals(VSR_PROGRAM_ID))[1]!;
    // layout: 8 disc | u16 idx | i8 digitShift | u64 baseline | u64 maxExtra | u64 saturation | option pubkey
    const data = cfg.data;
    expect(data.readUInt16LE(8)).toBe(0); // idx
    expect(data.readBigUInt64LE(11)).toBe(0n); // baselineVoteWeightScaledFactor == 0
    expect(data.readBigUInt64LE(19)).toBe(1_000_000_000n); // maxExtra factor 1e9 (1x)
    expect(Number(data.readBigUInt64LE(27))).toBe(365 * 86400); // micro saturation
  });
});

describe("governance config mirrors resolved params", () => {
  it("hold-up, quorum, threshold land in the on-chain config object", async () => {
    const params = resolveGovernanceParams({
      mode: "cypherpunk",
      tier: "micro",
      communitySupply: supply,
    });
    const dao = await cypherpunkDao();
    expect(dao.config.minInstructionHoldUpTime).toBe(params.holdUpSeconds);
    expect(dao.config.communityVoteThreshold.value).toBe(params.quorumPercent);
    expect(BigInt(dao.config.minCommunityTokensToCreateProposal.toString())).toBe(
      params.proposalThresholdTokens,
    );
  });
});

describe("mode is structural (spec 6.3 / 12.2)", () => {
  it("cypherpunk: no council mint ixs, council veto threshold disabled", async () => {
    const dao = await cypherpunkDao();
    const tokenIxs = dao.ixs.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID));
    expect(tokenIxs).toHaveLength(0);
    expect(dao.config.councilVetoVoteThreshold.type).toBe(2); // Disabled
  });

  it("council: mint created with 0 decimals, 1 token per member, authority nulled, veto threshold set", async () => {
    const members = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const councilMint = Keypair.generate().publicKey;
    const dao = await councilDao(members, councilMint);

    const createAccount = dao.ixs.find(
      (ix) =>
        ix.programId.equals(SystemProgram.programId) &&
        ix.keys[1]?.pubkey.equals(councilMint),
    );
    expect(createAccount, "system create for the council mint").toBeDefined();

    const tokenIxs = dao.ixs.filter((ix) => ix.programId.equals(TOKEN_PROGRAM_ID));
    // initializeMint2 + (mintTo per member) + setAuthority(null)
    expect(tokenIxs.length).toBe(1 + members.length + 1);
    const setAuthority = tokenIxs[tokenIxs.length - 1]!;
    // SetAuthority ix: data[0]==6, new authority option == None (data[2]==0)
    expect(setAuthority.data[0]).toBe(6);
    expect(setAuthority.data[2]).toBe(0);

    expect(dao.config.councilVetoVoteThreshold.type).toBe(0); // YesVotePercentage
    expect(dao.config.councilVetoVoteThreshold.value).toBe(60);
  });

  it("council mode requires members and mint; non-council rejects council config", async () => {
    await expect(
      buildCreateDaoIxs({
        mint,
        payer,
        mode: "council",
        params: resolveGovernanceParams({
          mode: "council",
          tier: "micro",
          communitySupply: supply,
        }),
      }),
    ).rejects.toThrow(/council/);

    await expect(
      buildCreateDaoIxs({
        mint,
        payer,
        mode: "cypherpunk",
        params: resolveGovernanceParams({
          mode: "cypherpunk",
          tier: "micro",
          communitySupply: supply,
        }),
        council: {
          mint: Keypair.generate().publicKey,
          members: [Keypair.generate().publicKey],
          vetoThresholdPercent: 60,
          mintRentLamports: 1_461_600n,
        },
      }),
    ).rejects.toThrow(/council/);
  });
});

describe("no platform backdoor (spec 6.3)", () => {
  it("the final governance ix sets realm authority to the governance PDA", async () => {
    const dao = await cypherpunkDao();
    const govIxs = dao.ixs.filter((ix) =>
      ix.programId.equals(SPL_GOVERNANCE_PROGRAM_ID),
    );
    const last = govIxs[govIxs.length - 1]!;
    // SetRealmAuthority accounts: [realm, currentAuthority(signer), newAuthority]
    expect(last.keys[0]!.pubkey.equals(dao.realm)).toBe(true);
    expect(last.keys[1]!.pubkey.equals(payer)).toBe(true);
    expect(last.keys[1]!.isSigner).toBe(true);
    expect(last.keys[2]!.pubkey.equals(dao.governance)).toBe(true);
  });

  it("VSR registrar creation happens BEFORE the authority transfer (it needs the authority signature)", async () => {
    const dao = await cypherpunkDao();
    const vsrIdx = dao.ixs.findIndex((ix) => ix.programId.equals(VSR_PROGRAM_ID));
    const govIxs = dao.ixs
      .map((ix, i) => ({ ix, i }))
      .filter(({ ix }) => ix.programId.equals(SPL_GOVERNANCE_PROGRAM_ID));
    const setAuthorityIdx = govIxs[govIxs.length - 1]!.i;
    expect(vsrIdx).toBeGreaterThan(-1);
    expect(vsrIdx).toBeLessThan(setAuthorityIdx);
  });
});
