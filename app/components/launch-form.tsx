"use client";

/**
 * Launch form — spec 6.7, client-only. Renders validateLaunchForm results
 * live (the shared contract that also guards on-chain) and, on submit,
 * resolves the governance plan in-browser. No server: the resolved plan is
 * what a wallet-driven launch would enact.
 */
import { useMemo, useState } from "react";
import {
  validateLaunchForm,
  type GovernanceMode,
  type GovernanceParams,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";

const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];

interface LaunchPlan {
  mode: GovernanceMode;
  tier: MarketCapTier;
  params: GovernanceParams;
}

export function LaunchForm({ mode }: { mode: GovernanceMode }) {
  const [tier, setTier] = useState<MarketCapTier>("micro");
  const [councilMembers, setCouncilMembers] = useState("");
  const [vetoPercent, setVetoPercent] = useState("60");
  const [sovereignHoldUp, setSovereignHoldUp] = useState("");
  const [overrideHoldUp, setOverrideHoldUp] = useState("");
  const [overrideQuorum, setOverrideQuorum] = useState("");
  const [confirmations, setConfirmations] = useState<
    LaunchFormInput["confirmations"]
  >({});
  const [plan, setPlan] = useState<LaunchPlan | null>(null);

  const form = useMemo<LaunchFormInput>(() => {
    const overrides: NonNullable<LaunchFormInput["overrides"]> = {};
    if (overrideHoldUp !== "") overrides.holdUpSeconds = Number(overrideHoldUp);
    if (overrideQuorum !== "") overrides.quorumPercent = Number(overrideQuorum);
    return {
      mode,
      tier,
      ...(mode === "council"
        ? {
            councilMembers: councilMembers
              .split("\n")
              .map((m) => m.trim())
              .filter(Boolean),
            councilVetoThresholdPercent: Number(vetoPercent),
          }
        : {}),
      ...(mode === "sovereign" && sovereignHoldUp !== ""
        ? { sovereignHoldUpSeconds: Number(sovereignHoldUp) }
        : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      confirmations,
    };
  }, [
    mode,
    tier,
    councilMembers,
    vetoPercent,
    sovereignHoldUp,
    overrideHoldUp,
    overrideQuorum,
    confirmations,
  ]);

  const validated = useMemo(() => validateLaunchForm(form), [form]);
  const errors = validated.errors;

  function confirm(key: keyof LaunchFormInput["confirmations"]) {
    return (
      <input
        type="checkbox"
        data-testid={`confirm-${key}`}
        checked={confirmations[key] ?? false}
        onChange={(e) =>
          setConfirmations({ ...confirmations, [key]: e.target.checked })
        }
      />
    );
  }

  function submit() {
    if (validated.ok && validated.params) {
      setPlan({ mode, tier, params: validated.params });
    }
  }

  if (plan) {
    return (
      <>
        <p className="muted">
          Resolved governance plan — this is what a wallet-driven launch
          enacts on-chain (no server involved).
        </p>
        <pre className="result" data-testid="launch-result">
          {JSON.stringify(
            {
              mode: plan.mode,
              tier: plan.tier,
              params: {
                quorumPercent: plan.params.quorumPercent,
                holdUpSeconds: plan.params.holdUpSeconds,
                proposalThresholdTokens:
                  plan.params.proposalThresholdTokens.toString(),
                lockupSaturationSeconds: plan.params.lockupSaturationSeconds,
                vetoEnabled: plan.params.vetoEnabled,
              },
            },
            null,
            2,
          )}
        </pre>
        <button
          className="button"
          type="button"
          data-testid="launch-back"
          onClick={() => setPlan(null)}
        >
          Edit
        </button>
      </>
    );
  }

  return (
    <form
      className="launch"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label htmlFor="tier">Market-cap tier (sets the floors)</label>
      <select
        id="tier"
        data-testid="tier-select"
        value={tier}
        onChange={(e) => setTier(e.target.value as MarketCapTier)}
      >
        {TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      {mode === "council" && (
        <>
          <label htmlFor="council-members">
            Council members (one pubkey per line, fixed at launch)
          </label>
          <textarea
            id="council-members"
            data-testid="council-members"
            rows={4}
            value={councilMembers}
            onChange={(e) => setCouncilMembers(e.target.value)}
          />
          <label htmlFor="veto-percent">Council veto threshold (%)</label>
          <input
            id="veto-percent"
            data-testid="veto-percent"
            type="number"
            value={vetoPercent}
            onChange={(e) => setVetoPercent(e.target.value)}
          />
        </>
      )}

      {mode === "sovereign" && (
        <>
          <label htmlFor="sovereign-holdup">
            Hold-up in seconds (0 is allowed — that is the point)
          </label>
          <input
            id="sovereign-holdup"
            data-testid="sovereign-holdup"
            type="number"
            min={0}
            value={sovereignHoldUp}
            onChange={(e) => setSovereignHoldUp(e.target.value)}
          />
        </>
      )}

      {mode !== "sovereign" && (
        <>
          <label htmlFor="override-holdup">
            Hold-up override in seconds (stricter than the tier floor only)
          </label>
          <input
            id="override-holdup"
            data-testid="override-holdup"
            type="number"
            value={overrideHoldUp}
            onChange={(e) => setOverrideHoldUp(e.target.value)}
          />
          <label htmlFor="override-quorum">
            Quorum override % (stricter than the tier floor only)
          </label>
          <input
            id="override-quorum"
            data-testid="override-quorum"
            type="number"
            value={overrideQuorum}
            onChange={(e) => setOverrideQuorum(e.target.value)}
          />
        </>
      )}

      {mode === "cypherpunk" && (
        <div className="confirm">
          {confirm("noVetoIrreversible")}
          <span>
            I understand: <b>no veto, irreversible</b>. Nothing can stop a
            passed proposal except the hold-up window.
          </span>
        </div>
      )}

      {mode === "sovereign" && (
        <>
          <div className="confirm">
            {confirm("noVeto")}
            <span>
              I understand: <b>no veto</b> exists in this DAO.
            </span>
          </div>
          <div className="confirm">
            {confirm("canDrainImmediately")}
            <span>
              I understand: <b>no timelock floor</b> — this DAO can drain
              itself the moment a vote passes.
            </span>
          </div>
        </>
      )}

      {errors.length > 0 && (
        <ul className="errors" data-testid="form-errors">
          {errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      {validated.ok && validated.params && (
        <p className="muted" data-testid="resolved-params">
          quorum {validated.params.quorumPercent}% · hold-up{" "}
          {validated.params.holdUpSeconds}s · veto{" "}
          {validated.params.vetoEnabled ? "enabled" : "none"}
        </p>
      )}

      <button
        className="button"
        type="submit"
        data-testid="launch-submit"
        disabled={!validated.ok}
      >
        Resolve launch plan
      </button>
    </form>
  );
}
