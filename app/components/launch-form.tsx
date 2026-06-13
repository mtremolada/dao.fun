"use client";

/**
 * Launch form — spec 6.7, client-only. Governance settings are SLIDERS bounded
 * to only the valid range (the mode×tier matrix floors), so a sub-floor value
 * is structurally unreachable — validateLaunchForm never has to reject one.
 * When valid and a wallet is connected, "Launch" runs the on-chain ceremony in
 * the browser via the connected wallet (no server). Real SOL on mainnet.
 */
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  validateLaunchForm,
  type GovernanceMode,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";
import { TIER_FLOORS, holdUpFloorSeconds } from "@daofun/sdk/matrix";
import { getConnection } from "../lib/solana";
import { runLaunch, type LaunchResult, type LaunchStepState } from "../lib/launch";
import { prepareImage, uploadPumpMetadata } from "../lib/pump-metadata";
import { useWallet } from "./wallet-provider";

const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];
const TIER_LABELS: Record<MarketCapTier, string> = {
  micro: "Micro (<$50k)",
  small: "Small ($50k–300k)",
  mid: "Mid ($300k–5M)",
  large: "Large (>$5M)",
};

const HOUR = 3600;
const DAY = 86400;
const MAX_HOLDUP = 30 * DAY; // generous cap; floor is the meaningful bound

const FEE_TREASURY = process.env.NEXT_PUBLIC_PROTOCOL_TREASURY || "";
const FEE_LAMPORTS = BigInt(process.env.NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS || "0");
// Guarded unlock (D-034): the gate ceremony + SDK are complete, but Guarded
// only WORKS once the proposal-gate program is live on this cluster. Set this
// ONLY after the program is deployed — otherwise a guarded launch bricks the
// DAO at the gate-init step.
const GUARDED_ENABLED = process.env.NEXT_PUBLIC_GUARDED_ENABLED === "1";

function fmtDuration(s: number): string {
  if (s <= 0) return "0 — instant";
  const d = Math.floor(s / DAY);
  const h = Math.round((s % DAY) / HOUR);
  if (d && h) return `${d}d ${h}h`;
  if (d) return `${d} day${d > 1 ? "s" : ""}`;
  return `${h}h`;
}

function parseMembers(raw: string): string[] {
  return raw
    .split("\n")
    .map((m) => m.trim())
    .filter(Boolean);
}

/** A labelled range input with a live value readout. */
function RangeField(props: {
  testid: string;
  label: string;
  hint?: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="field">
      <div className="field-head">
        <label htmlFor={props.testid}>{props.label}</label>
        <span className="slider-val" data-testid={`${props.testid}-val`}>
          {props.display}
        </span>
      </div>
      <input
        id={props.testid}
        data-testid={props.testid}
        className="slider"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {props.hint && <p className="muted slider-hint">{props.hint}</p>}
    </div>
  );
}

export function LaunchForm({ mode }: { mode: GovernanceMode }) {
  const { sender, openModal } = useWallet();

  const [tier, setTier] = useState<MarketCapTier>("micro");
  const [councilMembers, setCouncilMembers] = useState("");
  const [veto, setVeto] = useState(60);
  // hold-up / quorum sliders hold a raw value; the effective value is always
  // clamped UP to the current mode×tier floor, so sub-floor is unreachable.
  const [holdUp, setHoldUp] = useState(0);
  const [quorum, setQuorum] = useState(0);
  const [sovereignHoldUp, setSovereignHoldUp] = useState(0);
  const [confirmations, setConfirmations] = useState<
    LaunchFormInput["confirmations"]
  >({});

  // token metadata
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [uri, setUri] = useState(""); // advanced: pre-hosted metadata URI
  const [devBuy, setDevBuy] = useState("");

  const [steps, setSteps] = useState<LaunchStepState[]>([]);
  const [launching, setLaunching] = useState(false);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);

  // ---- valid-only bounds, derived from the mode×tier matrix ----
  const floors = TIER_FLOORS[tier];
  const holdUpFloor = mode === "sovereign" ? 0 : holdUpFloorSeconds(mode, tier);
  const quorumFloor = floors.quorumPercent;
  const effHoldUp = Math.max(holdUp, holdUpFloor); // council/cypherpunk
  const effQuorum = Math.max(quorum, quorumFloor);
  const effSovereign = Math.min(Math.max(sovereignHoldUp, 0), MAX_HOLDUP);

  const form = useMemo<LaunchFormInput>(() => {
    return {
      mode,
      tier,
      ...(mode === "council"
        ? {
            councilMembers: parseMembers(councilMembers),
            councilVetoThresholdPercent: veto,
          }
        : {}),
      ...(mode === "sovereign"
        ? { sovereignHoldUpSeconds: effSovereign }
        : {}),
      // Overrides only ever tighten; the slider min IS the floor, so these
      // are always valid (sovereign is exempt — no overrides).
      ...(mode !== "sovereign"
        ? { overrides: { holdUpSeconds: effHoldUp, quorumPercent: effQuorum } }
        : {}),
      confirmations,
    };
  }, [
    mode,
    tier,
    councilMembers,
    veto,
    effHoldUp,
    effQuorum,
    effSovereign,
    confirmations,
  ]);

  const validated = useMemo(
    () => validateLaunchForm(form, { guardedEnabled: GUARDED_ENABLED }),
    [form],
  );
  const metadataReady =
    name.trim() !== "" &&
    symbol.trim() !== "" &&
    (image !== null || uri.trim() !== "");

  function onPickImage(file: File | null) {
    setImage(file);
    setImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : "";
    });
  }

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
      setLaunchError(
        "Add a name, symbol, and an image (or paste a metadata URI under Advanced).",
      );
      return;
    }
    if (!sender) {
      openModal();
      return;
    }
    setLaunching(true);
    setSteps([]);
    try {
      // Resolve the metadata URI: use a pasted one, else upload the image.
      let metadataUri = uri.trim();
      if (!metadataUri && image) {
        setSteps([{ step: "Upload image & metadata", status: "running" }]);
        const blob = await prepareImage(image);
        metadataUri = await uploadPumpMetadata({
          image: blob,
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim(),
        });
        setSteps([{ step: "Upload image & metadata", status: "done" }]);
      }
      const res = await runLaunch(
        getConnection(),
        sender,
        {
          mode,
          tier,
          params: validated.params,
          metadata: { name: name.trim(), symbol: symbol.trim(), uri: metadataUri },
          ...(devBuy !== "" && Number(devBuy) > 0
            ? { devBuyLamports: BigInt(Math.floor(Number(devBuy) * 1e9)) }
            : {}),
          ...(mode === "council" || mode === "guarded"
            ? {
                council: {
                  members: parseMembers(councilMembers),
                  vetoThresholdPercent: veto,
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
        <pre className="result">{JSON.stringify(result, null, 2)}</pre>
        <p style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <Link
            className="button"
            href={`/dao?realm=${result.realm}&vault=${result.vault}&ms=${result.multisig}`}
          >
            View &amp; verify your DAO
          </Link>
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

      <h2>Token</h2>
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

      <label htmlFor="coin-image">
        Image (any image — it&apos;s auto-cropped to a square and uploaded)
      </label>
      <input
        id="coin-image"
        data-testid="coin-image"
        type="file"
        accept="image/*"
        onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
      />
      {imageUrl && (
        <img
          src={imageUrl}
          alt="preview"
          width={96}
          height={96}
          style={{
            objectFit: "cover",
            borderRadius: 12,
            border: "1px solid var(--border)",
            marginTop: "0.5rem",
          }}
        />
      )}

      <label htmlFor="coin-desc">Description (optional)</label>
      <textarea
        id="coin-desc"
        data-testid="coin-desc"
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />

      <label htmlFor="dev-buy">Optional dev-buy at launch (SOL)</label>
      <input
        id="dev-buy"
        data-testid="dev-buy"
        type="number"
        min={0}
        step="0.01"
        value={devBuy}
        onChange={(e) => setDevBuy(e.target.value)}
      />

      <h2>Governance</h2>

      {/* Tier slider — sets the matrix floors. */}
      <RangeField
        testid="tier-slider"
        label="Market-cap tier"
        min={0}
        max={TIERS.length - 1}
        step={1}
        value={TIERS.indexOf(tier)}
        display={TIER_LABELS[tier]}
        onChange={(v) => setTier(TIERS[v] ?? "micro")}
        hint="Higher tiers ease the floors (a bigger, more liquid market needs less friction). You can only set values stricter than the floor."
      />
      <div className="tier-ticks" aria-hidden>
        {TIERS.map((t) => (
          <span key={t} className={t === tier ? "on" : undefined}>
            {t}
          </span>
        ))}
      </div>

      {(mode === "council" || mode === "guarded") && (
        <>
          <label htmlFor="council-members">
            Council members (one pubkey per line, fixed at launch — they can
            only veto)
          </label>
          <textarea
            id="council-members"
            data-testid="council-members"
            rows={4}
            value={councilMembers}
            onChange={(e) => setCouncilMembers(e.target.value)}
          />
          <RangeField
            testid="veto-percent"
            label="Council veto threshold"
            min={1}
            max={100}
            step={1}
            value={veto}
            display={`${veto}%`}
            onChange={setVeto}
            hint="Share of the council that must vote to veto a passing proposal during the hold-up."
          />
        </>
      )}

      {/* Sovereign: hold-up can be ZERO (that is the point). */}
      {mode === "sovereign" && (
        <RangeField
          testid="sovereign-holdup"
          label="Hold-up (delay before a passed vote can execute)"
          min={0}
          max={MAX_HOLDUP}
          step={HOUR}
          value={effSovereign}
          display={fmtDuration(effSovereign)}
          onChange={setSovereignHoldUp}
          hint="0 is allowed in Sovereign — funds can move the moment a vote passes."
        />
      )}

      {/* Council / Cypherpunk: hold-up + quorum, floored by the matrix. */}
      {mode !== "sovereign" && (
        <>
          <RangeField
            testid="override-holdup"
            label="Hold-up (delay before a passed vote can execute)"
            min={holdUpFloor}
            max={MAX_HOLDUP}
            step={HOUR}
            value={effHoldUp}
            display={fmtDuration(effHoldUp)}
            onChange={setHoldUp}
            hint={`Tier floor: ${fmtDuration(holdUpFloor)} — the slider can only go stricter (longer).`}
          />
          <RangeField
            testid="override-quorum"
            label="Quorum (% of vote weight that must approve)"
            min={quorumFloor}
            max={100}
            step={1}
            value={effQuorum}
            display={`${effQuorum}%`}
            onChange={setQuorum}
            hint={`Tier floor: ${quorumFloor}% — the slider can only go stricter (higher).`}
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

      <details>
        <summary className="muted">Advanced: paste a metadata URI</summary>
        <label htmlFor="coin-uri">
          Pre-hosted metadata JSON URI (overrides the image upload)
        </label>
        <input
          id="coin-uri"
          data-testid="coin-uri"
          type="text"
          value={uri}
          onChange={(e) => setUri(e.target.value)}
        />
      </details>

      {validated.errors.length > 0 && (
        <ul className="errors" data-testid="form-errors">
          {validated.errors.map((err) => (
            <li key={err}>{err}</li>
          ))}
        </ul>
      )}

      {validated.ok && validated.params && (
        <div className="summary-card" data-testid="resolved-params">
          <div className="row">
            <span>Quorum</span>
            <span>{validated.params.quorumPercent}%</span>
          </div>
          <div className="row">
            <span>Hold-up</span>
            <span>
              {fmtDuration(validated.params.holdUpSeconds)} (
              {validated.params.holdUpSeconds}s)
            </span>
          </div>
          <div className="row">
            <span>Veto</span>
            <span>
              {validated.params.vetoEnabled ? `${veto}% council` : "none"}
            </span>
          </div>
        </div>
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
