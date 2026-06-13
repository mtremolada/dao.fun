"use client";

/**
 * Launch form — spec 6.7, client-only. The governance settings render live
 * from the shared contract (validateLaunchForm); when valid and a wallet is
 * connected, "Launch" runs the on-chain ceremony in the browser via the
 * connected wallet (no server). Real SOL is spent on Solana mainnet.
 */
import { useMemo, useState } from "react";
import {
  validateLaunchForm,
  type GovernanceMode,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";
import { getConnection } from "../lib/solana";
import { runLaunch, type LaunchResult, type LaunchStepState } from "../lib/launch";
import { useWallet } from "./wallet-provider";

const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];

const FEE_TREASURY = process.env.NEXT_PUBLIC_PROTOCOL_TREASURY || "";
const FEE_LAMPORTS = BigInt(process.env.NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS || "0");

export function LaunchForm({ mode }: { mode: GovernanceMode }) {
  const { sender, openModal } = useWallet();

  const [tier, setTier] = useState<MarketCapTier>("micro");
  const [councilMembers, setCouncilMembers] = useState("");
  const [vetoPercent, setVetoPercent] = useState("60");
  const [sovereignHoldUp, setSovereignHoldUp] = useState("");
  const [overrideHoldUp, setOverrideHoldUp] = useState("");
  const [overrideQuorum, setOverrideQuorum] = useState("");
  const [confirmations, setConfirmations] = useState<
    LaunchFormInput["confirmations"]
  >({});

  // token metadata
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [devBuy, setDevBuy] = useState("");

  const [steps, setSteps] = useState<LaunchStepState[]>([]);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

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
  const metadataReady =
    name.trim() !== "" && symbol.trim() !== "" && uri.trim() !== "";

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

  async function launch() {
    setLaunchError(null);
    if (!validated.ok || !validated.params) return;
    if (!metadataReady) {
      setLaunchError("Enter the coin name, symbol, and metadata URI.");
      return;
    }
    if (!sender) {
      openModal();
      return;
    }
    setLaunching(true);
    setSteps([]);
    try {
      const res = await runLaunch(
        getConnection(),
        sender,
        {
          mode,
          tier,
          params: validated.params,
          metadata: { name: name.trim(), symbol: symbol.trim(), uri: uri.trim() },
          ...(devBuy !== "" && Number(devBuy) > 0
            ? { devBuyLamports: BigInt(Math.floor(Number(devBuy) * 1e9)) }
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
          ...(FEE_TREASURY && FEE_LAMPORTS > 0n
            ? { launchFee: { treasury: FEE_TREASURY, lamports: FEE_LAMPORTS } }
            : {}),
        },
        (s) => setSteps((prev) => [...prev.filter((p) => p.step !== s.step), s]),
      );
      setResult(res);
    } catch (e) {
      setLaunchError((e as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  if (result) {
    return (
      <div data-testid="launch-result">
        <p className="badge" data-state="verified">
          DAO launched 🎉
        </p>
        <pre className="result">
          {JSON.stringify(result, null, 2)}
        </pre>
        <p>
          <a
            className="button"
            href={`https://pump.fun/coin/${result.mint}`}
            target="_blank"
            rel="noreferrer"
          >
            View coin on pump.fun
          </a>
        </p>
      </div>
    );
  }

  return (
    <form
      className="launch"
      onSubmit={(e) => {
        e.preventDefault();
        void launch();
      }}
    >
      <p className="errors" style={{ paddingLeft: 0 }}>
        ⚠ Real launch — this spends SOL on Solana mainnet and creates on-chain
        accounts. Beta: try a small amount first.
      </p>

      <label htmlFor="coin-name">Coin name</label>
      <input
        id="coin-name"
        data-testid="coin-name"
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="coin-symbol">Symbol (ticker)</label>
      <input
        id="coin-symbol"
        data-testid="coin-symbol"
        type="text"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
      />
      <label htmlFor="coin-uri">
        Metadata URI (JSON with name/symbol/image — e.g. from pump.fun or your
        own host)
      </label>
      <input
        id="coin-uri"
        data-testid="coin-uri"
        type="text"
        value={uri}
        onChange={(e) => setUri(e.target.value)}
      />
      <label htmlFor="dev-buy">Optional dev-buy at launch (SOL)</label>
      <input
        id="dev-buy"
        data-testid="dev-buy"
        type="number"
        min={0}
        value={devBuy}
        onChange={(e) => setDevBuy(e.target.value)}
      />

      <label htmlFor="tier">Market-cap tier (sets the governance floors)</label>
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

      {validated.errors.length > 0 && (
        <ul className="errors" data-testid="form-errors">
          {validated.errors.map((err) => (
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

      {steps.length > 0 && (
        <ul className="result" data-testid="launch-progress">
          {steps.map((s) => (
            <li key={s.step}>
              {s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏳"}{" "}
              {s.step}
              {s.error ? ` — ${s.error}` : ""}
            </li>
          ))}
        </ul>
      )}

      {launchError && (
        <p className="errors" data-testid="launch-error">
          {launchError}
        </p>
      )}

      <button
        className="button"
        type="submit"
        data-testid="launch-submit"
        disabled={!validated.ok || launching}
      >
        {launching
          ? "Launching…"
          : sender
            ? "Launch on mainnet"
            : "Connect wallet to launch"}
      </button>
    </form>
  );
}
