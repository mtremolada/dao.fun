/**
 * Serverless per-token DAO discovery (durability): given ONLY the mint, the
 * realm/governance/treasury are deterministic (offline) and the proposal list
 * — votes + DEX-paid bounty reimbursements — is enumerated straight from chain.
 * Nothing here depends on a server or stored index, so it can't be lost.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  ProposalState,
  getProposalsByGovernance,
} from "@solana/spl-governance";
import { deriveGovernanceChainFromMint } from "@daofun/sdk/pda";
import { daoFromMint, listProposals } from "../lib/chain";

const mint = Keypair.generate().publicKey;

describe("daoFromMint", () => {
  it("derives the realm/governance/treasury deterministically from the mint (no RPC)", () => {
    const chain = deriveGovernanceChainFromMint(mint);
    const dao = daoFromMint(mint);
    expect(dao.realm).toBe(chain.realm.toBase58());
    expect(dao.governance).toBe(chain.governance.toBase58());
    expect(dao.nativeTreasury).toBe(chain.nativeTreasury.toBase58());
    // stable across calls — the link from a token to its DAO is reproducible
    expect(daoFromMint(mint)).toEqual(dao);
  });
});

describe("listProposals", () => {
  const fake = (
    name: string,
    state: ProposalState,
    completed: number | null,
  ) => ({
    pubkey: Keypair.generate().publicKey,
    account: {
      name,
      state,
      votingCompletedAt: completed === null ? null : { toNumber: () => completed },
    },
  });

  it("maps + sorts proposals (newest first) with the right claim status", async () => {
    const succeeded = fake("bounty reimbursement", ProposalState.Succeeded, 200);
    const voting = fake("open vote", ProposalState.Voting, null);
    const defeated = fake("rejected sweep", ProposalState.Defeated, 100);

    const enumerate = (async () => [
      voting,
      succeeded,
      defeated,
    ]) as unknown as typeof getProposalsByGovernance;

    const out = await listProposals({} as never, mint, { enumerate });

    // newest voting-completed first; nulls last
    expect(out.map((p) => p.name)).toEqual([
      "bounty reimbursement",
      "rejected sweep",
      "open vote",
    ]);
    // a passed reimbursement is claimable; a defeated one is rejected; an open
    // vote is not-ready — exactly the bounty lifecycle the DAO view shows
    expect(out[0]!.claimStatus).toBe("claimable");
    expect(out[1]!.claimStatus).toBe("rejected");
    expect(out[2]!.claimStatus).toBe("not-ready");
    expect(out[0]!.state).toBe("Succeeded");
    expect(out[0]!.address).toBe(succeeded.pubkey.toBase58());
  });

  it("returns an empty list when the DAO has no proposals yet", async () => {
    const enumerate = (async () => []) as unknown as typeof getProposalsByGovernance;
    expect(await listProposals({} as never, mint, { enumerate })).toEqual([]);
  });
});
