/**
 * AUDIT — setParam ratchet-by-omission (INV-11 / D-025), SAFE verdict backed
 * by a COMPLETE config-preservation regression.
 *
 * The menu's anti-capture guarantee is that a setParam proposal changes ONLY
 * its target field and preserves every other GovernanceConfig field verbatim —
 * in particular the veto thresholds (a cypherpunk DAO cannot acquire a council
 * veto; a council DAO cannot drop its veto), vote tipping (the exit window),
 * cool-off, and the deposit exemption. The integration test
 * (action-setparam.integration) spot-checks a SUBSET of fields; this pins ALL
 * of them, including ones it omits (councilVetoVoteThreshold.value,
 * communityVetoVoteThreshold, councilVoteThreshold, councilVoteTipping,
 * votingCoolOffTime), starting from a council-mode config whose veto is ACTIVE
 * — exactly the field an attacker would want to silently drop.
 */
import { describe, expect, it } from "vitest";
import BN from "bn.js";
import {
  GovernanceConfig,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
} from "@solana/spl-governance";
import {
  SET_PARAM_WHITELIST,
  buildSetParamIxs,
  type SetParamId,
} from "../src/actions";
import { PublicKey } from "@solana/web3.js";

// A council-mode-shaped config as the chain reader would decode it: an ACTIVE
// council veto (55%), strict council tipping, disabled community veto.
function councilConfig(): GovernanceConfig {
  return new GovernanceConfig({
    communityVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: 25,
    }),
    minCommunityTokensToCreateProposal: new BN("4000000000"),
    minInstructionHoldUpTime: 72 * 3600,
    baseVotingTime: 3 * 86400,
    communityVoteTipping: VoteTipping.Disabled,
    minCouncilTokensToCreateProposal: new BN(1),
    councilVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled }),
    councilVetoVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: 55,
    }),
    communityVetoVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.Disabled,
    }),
    councilVoteTipping: VoteTipping.Strict,
    votingCoolOffTime: 0,
    depositExemptProposalCount: 10,
  });
}

function assertOnlyChanged(
  before: GovernanceConfig,
  after: GovernanceConfig,
  changed: SetParamId,
) {
  // Every field below is asserted byte-identical EXCEPT the named target.
  if (changed !== "quorumPercent") {
    expect(after.communityVoteThreshold.type).toBe(
      before.communityVoteThreshold.type,
    );
    expect(after.communityVoteThreshold.value).toBe(
      before.communityVoteThreshold.value,
    );
  }
  if (changed !== "proposalThresholdTokens") {
    expect(
      after.minCommunityTokensToCreateProposal.eq(
        before.minCommunityTokensToCreateProposal,
      ),
    ).toBe(true);
  }
  if (changed !== "holdUpSeconds") {
    expect(after.minInstructionHoldUpTime).toBe(before.minInstructionHoldUpTime);
  }
  if (changed !== "baseVotingTime") {
    expect(after.baseVotingTime).toBe(before.baseVotingTime);
  }
  // The fields the menu must NEVER touch — the ratchet/veto surface.
  expect(after.communityVoteTipping).toBe(before.communityVoteTipping);
  expect(after.minCouncilTokensToCreateProposal.eq(
    before.minCouncilTokensToCreateProposal,
  )).toBe(true);
  expect(after.councilVoteThreshold.type).toBe(before.councilVoteThreshold.type);
  expect(after.councilVetoVoteThreshold.type).toBe(
    before.councilVetoVoteThreshold.type,
  );
  expect(after.councilVetoVoteThreshold.value).toBe(
    before.councilVetoVoteThreshold.value,
  );
  expect(after.communityVetoVoteThreshold.type).toBe(
    before.communityVetoVoteThreshold.type,
  );
  expect(after.councilVoteTipping).toBe(before.councilVoteTipping);
  expect(after.votingCoolOffTime).toBe(before.votingCoolOffTime);
  expect(after.depositExemptProposalCount).toBe(
    before.depositExemptProposalCount,
  );
}

const governance = new PublicKey("11111111111111111111111111111112");
const SUPPLY = 200_000_000_000n;

describe("AUDIT setParam: every non-target config field is preserved (council veto stays active)", () => {
  const cases: { id: SetParamId; value: bigint }[] = [
    { id: "holdUpSeconds", value: BigInt(96 * 3600) },
    { id: "quorumPercent", value: 30n },
    { id: "proposalThresholdTokens", value: 8_000_000_000n },
    { id: "baseVotingTime", value: BigInt(4 * 86400) },
  ];

  it("the whitelist is exactly the four expected params", () => {
    expect([...SET_PARAM_WHITELIST].sort()).toEqual(
      ["baseVotingTime", "holdUpSeconds", "proposalThresholdTokens", "quorumPercent"].sort(),
    );
  });

  for (const c of cases) {
    it(`changing ${c.id} preserves the active council veto and all other fields`, () => {
      const before = councilConfig();
      const { newConfig } = buildSetParamIxs({
        governance,
        currentConfig: before,
        mode: "council",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId: c.id,
        value: c.value,
      });
      // The veto an attacker would try to drop is still 55% YesVotePercentage.
      expect(newConfig.councilVetoVoteThreshold.type).toBe(
        VoteThresholdType.YesVotePercentage,
      );
      expect(newConfig.councilVetoVoteThreshold.value).toBe(55);
      assertOnlyChanged(before, newConfig, c.id);
    });
  }

  // The u32 fields must reject out-of-range values with a CLEAR error rather
  // than letting the borsh encoder throw a cryptic RangeError mid-build (or, in
  // a future encoder, silently truncate to a tiny on-chain window).
  for (const id of ["holdUpSeconds", "baseVotingTime"] as const) {
    it(`rejects an out-of-u32 ${id} instead of emitting a malformed config`, () => {
      expect(() =>
        buildSetParamIxs({
          governance,
          currentConfig: councilConfig(),
          mode: "council",
          tier: "micro",
          communitySupply: SUPPLY,
          paramId: id,
          value: 4_294_967_296n, // u32::MAX + 1
        }),
      ).toThrow(/u32/);
    });
  }
});
