"use client";

/**
 * Launch form — spec 6.7. Renders validateLaunchForm results live (the
 * same function the server re-validates with) and posts the raw form to
 * the backend; resolved params and errors all come from the shared
 * contract, never from component logic.
 */
import { useMemo, useState } from "react";
import {
  validateLaunchForm,
  type GovernanceMode,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";
import type { LaunchFlowState } from "../lib/launch";
import {
  connectWallet,
  discoverWallets,
  makeSigner,
} from "../lib/wallet-standard";

const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];
// Fully self-service when an RPC is configured: the user's wallet pays + signs
// the whole launch in the browser. No backend, no server key (decentralized).
const RPC = process.env.NEXT_PUBLIC_RPC_URL;
const PROTOCOL_TREASURY = process.env.NEXT_PUBLIC_PROTOCOL_TREASURY;
const LAUNCH_FEE = process.env.NEXT_PUBLIC_LAUNCH_FEE; // lamports; omit/0 = no fee

interface LaunchState {
  launchId: string;
  status: string;
  completedSteps: Record<string, string[]>;
  failedStep?: string;
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
  const [submitting, setSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [result, setResult] = useState<LaunchState | null>(null);
  // token metadata (the governance form lacks it) + self-service launch state
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [selfServe, setSelfServe] = useState<LaunchFlowState | null>(null);

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
  const errors = [...validated.errors, ...serverErrors];

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

  async function deploySelfService() {
    if (!name || !symbol || !uri) {
      setServerErrors(["Token name, symbol, and metadata URI are required."]);
      return;
    }
    setSubmitting(true);
    setServerErrors([]);
    try {
      const wallet = discoverWallets()[0];
      if (!wallet) {
        setServerErrors([
          "No wallet found — install a Solana wallet extension.",
        ]);
        return;
      }
      const signer = makeSigner(wallet, await connectWallet(wallet));
      const { launchFlow } = await import("../lib/launch");
      await launchFlow(
        {
          rpcUrl: RPC!,
          mode,
          tier,
          token: { name, symbol, uri },
          ...(mode === "sovereign" && sovereignHoldUp !== ""
            ? { sovereignHoldUpSeconds: Number(sovereignHoldUp) }
            : {}),
          ...(mode === "council"
            ? {
                council: {
                  members: councilMembers
                    .split("\n")
                    .map((m) => m.trim())
                    .filter(Boolean),
                  vetoThresholdPercent: Number(vetoPercent),
                },
              }
            : {}),
          ...(PROTOCOL_TREASURY ? { protocolTreasury: PROTOCOL_TREASURY } : {}),
          ...(LAUNCH_FEE ? { launchFeeLamports: BigInt(LAUNCH_FEE) } : {}),
        },
        { signer, onState: setSelfServe },
      );
    } catch (e) {
      setServerErrors([(e as Error).message]);
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    // Decentralized: when an RPC is configured, the user's wallet does the
    // whole launch in-browser. Otherwise fall back to the server orchestrator.
    if (RPC) {
      await deploySelfService();
      return;
    }
    setSubmitting(true);
    setServerErrors([]);
    try {
      const res = await fetch("/api/launches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ launchId: crypto.randomUUID(), form }),
      });
      const body = (await res.json()) as LaunchState & { errors?: string[] };
      if (body.errors) {
        setServerErrors(body.errors);
      } else {
        setResult(body);
      }
    } catch (e) {
      setServerErrors([(e as Error).message]);
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <pre className="result" data-testid="launch-result">
        {JSON.stringify(result, null, 2)}
      </pre>
    );
  }

  if (selfServe) {
    return (
      <div className="result" data-testid="self-serve-result">
        <p>
          <strong>{selfServe.phase}</strong>
          {selfServe.step ? ` — ${selfServe.step}` : ""}
        </p>
        {selfServe.mint && (
          <p className="muted" style={{ wordBreak: "break-all" }}>
            mint {selfServe.mint}
            <br />
            realm {selfServe.realm}
          </p>
        )}
        <p className="muted">
          completed: {selfServe.completed.join(", ") || "—"}
        </p>
        {selfServe.error && <p className="errors">{selfServe.error}</p>}
      </div>
    );
  }

  return (
    <form
      className="launch"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
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

      {RPC && (
        <>
          <label htmlFor="token-name">Token name</label>
          <input
            id="token-name"
            data-testid="token-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label htmlFor="token-symbol">Token symbol</label>
          <input
            id="token-symbol"
            data-testid="token-symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
          <label htmlFor="token-uri">Metadata URI (json: name/image/…)</label>
          <input
            id="token-uri"
            data-testid="token-uri"
            value={uri}
            onChange={(e) => setUri(e.target.value)}
          />
        </>
      )}

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
        disabled={!validated.ok || submitting}
      >
        {submitting
          ? "Launching..."
          : RPC
            ? "Deploy with your wallet"
            : "Launch"}
      </button>
    </form>
  );
}
