/**
 * AUDIT — INV-9 for a DIRECT-LEG-ONLY proposal, end-to-end on the real
 * spl-governance binary (SAFE verdict, regression).
 *
 * gate1-matrix verifies the chain-side recompute (`chainHashOf` ->
 * `hashWrappedInstructionSet`) only for Squads-wrapped VAULT proposals. A
 * direct-leg-only proposal (setParam) stores a single un-wrapped
 * ProposalTransaction; the recompute must take the `catch` raw-hash fallback
 * (no vaultTransactionCreate to unwrap) and STILL match the published artifact
 * hash. This pins that on the real binary: the direct leg, re-read from chain
 * state and hashed, equals the descriptionLink the proposer published.
 */
import { describe, expect, it } from "vitest";
import { Governance } from "@solana/spl-governance";
import { buildSetParamIxs } from "../packages/sdk/src/actions";
import {
  SUPPLY,
  TEST_TIMEOUT,
  chainHashOf,
  createDao,
  proposeInner,
  readGov,
  startCtx,
} from "./helpers/bankrun-harness";

describe("AUDIT INV-9 (direct-leg-only): chain recompute matches the published hash on the real binary", () => {
  it(
    "a setParam direct leg re-read from chain hashes to the proposal's descriptionLink",
    async () => {
      const ctx = await startCtx();
      const dao = await createDao(ctx, "cypherpunk");
      const before = await readGov(ctx, dao.governance, Governance);

      const setParam = buildSetParamIxs({
        governance: dao.governance,
        currentConfig: before.config,
        mode: "cypherpunk",
        tier: "micro",
        communitySupply: SUPPLY,
        paramId: "holdUpSeconds",
        value: BigInt(96 * 3600),
      });

      const made = await proposeInner(
        ctx,
        dao,
        0,
        [], // no vault legs — direct-leg-only
        "raise hold-up",
        setParam.directIxs,
      );

      // The production chain reader's recompute (catch fallback) equals the
      // published artifact hash — the INV-9 badge would read "verified".
      expect(await chainHashOf(ctx, made)).toBe(made.innerHash);
    },
    TEST_TIMEOUT,
  );
});
