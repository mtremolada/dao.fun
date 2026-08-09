"use client";

/**
 * The ONE create page: a token, optionally with a DAO.
 *
 * Both toggle options ride the SAME bonding curve — "DAO token" only changes
 * WHO the coin's creator is. Simple: you. DAO: the treasury, so trading fees
 * accrue to it and the holders govern what happens to them. Everything the
 * DAO needs appears inline when you pick it; Guarded (the default) needs
 * nothing filled in at all, because its protection is structural.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  validateLaunchForm,
  type GovernanceMode,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";
import { useWallet } from "./wallet-provider";
import { makeSigningWallet } from "../lib/signing-wallet";
import { getConnection } from "../lib/solana";
import { createCoin } from "../lib/coin-actions";
import { runLaunch, type LaunchResult, type LaunchStepState } from "../lib/launch";
import { apiConfigured, launchpadApi } from "../lib/launchpad-api";
import { rememberCoin } from "../lib/chain-coin";
import type { SendState } from "../lib/tx-sender";
import { explorerTx } from "../lib/cluster";

type Kind = "simple" | "dao";

const PROTECTIONS: {
  id: GovernanceMode;
  name: string;
  badge?: string;
  danger?: boolean;
  copy: string;
  points: string[];
}[] = [
  {
    id: "guarded",
    name: "Guarded",
    badge: "recommended",
    copy: "Proposals can only come from the safety menu. Nothing to configure.",
    points: [
      "An on-chain gate authors every proposal — anything off-menu cannot be created at all",
      "Anyone can propose from the menu, and your holders vote as normal",
      "The menu covers grants, buybacks, liquidity, distributions and parameter changes",
    ],
  },
  {
    id: "council",
    name: "Council",
    copy: "People you name can veto a bad proposal before it executes.",
    points: [
      "The veto set is fixed at launch — the council mint's authority is burned",
      "The council can only veto; it can never pass a proposal of its own",
    ],
  },
  {
    id: "cypherpunk",
    name: "Cypherpunk",
    copy: "Pure token voting. No veto, no council — irreversible.",
    points: [
      "No council mint exists, so there is structurally no veto",
      "The hold-up window is the only exit route once a vote passes",
    ],
  },
  {
    id: "sovereign",
    name: "Sovereign",
    danger: true,
    copy: "No guardrails at all. The DAO can drain itself the moment a vote passes.",
    points: [
      "The hold-up can be ZERO — funds move the instant a vote passes",
      "Nothing stands between a winning vote and the treasury",
    ],
  },
];

const TIERS: { id: MarketCapTier; label: string; blurb: string }[] = [
  { id: "micro", label: "Micro", blurb: "Testing and small communities" },
  { id: "small", label: "Small", blurb: "A real community forming" },
  { id: "mid", label: "Mid", blurb: "Serious treasury, slower by design" },
  { id: "large", label: "Large", blurb: "Maximum caution" },
];

const FEE_TREASURY = process.env.NEXT_PUBLIC_PROTOCOL_TREASURY || "";
const FEE_LAMPORTS = BigInt(process.env.NEXT_PUBLIC_LAUNCH_FEE_LAMPORTS || "0");

const hours = (seconds: number) =>
  seconds === 0 ? "none" : seconds % 3600 === 0 ? `${seconds / 3600} h` : `${Math.round(seconds / 60)} min`;

async function fileToBase64(file: File): Promise<{ base64: string; mime: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return { base64: btoa(bin), mime: file.type };
}

export function CreateScreen() {
  const { wallet, account, sender, openModal } = useWallet();
  const router = useRouter();

  const [kind, setKind] = useState<Kind>("simple");

  // token
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [devBuy, setDevBuy] = useState("");

  // dao
  const [mode, setMode] = useState<GovernanceMode>("guarded");
  const [tier, setTier] = useState<MarketCapTier>("micro");
  const [councilMembers, setCouncilMembers] = useState("");
  const [vetoPercent, setVetoPercent] = useState("60");
  const [sovereignHoldUp, setSovereignHoldUp] = useState("");
  const [overrideHoldUp, setOverrideHoldUp] = useState("");
  const [overrideQuorum, setOverrideQuorum] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [confirmations, setConfirmations] = useState<LaunchFormInput["confirmations"]>({});

  // progress
  const [steps, setSteps] = useState<string[]>([]);
  const [daoSteps, setDaoSteps] = useState<LaunchStepState[]>([]);
  const [state, setState] = useState<SendState | null>(null);
  const [result, setResult] = useState<LaunchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const form = useMemo<LaunchFormInput>(() => {
    const overrides: NonNullable<LaunchFormInput["overrides"]> = {};
    if (overrideHoldUp !== "") overrides.holdUpSeconds = Number(overrideHoldUp);
    if (overrideQuorum !== "") overrides.quorumPercent = Number(overrideQuorum);
    return {
      mode,
      tier,
      ...(mode === "council"
        ? {
            councilMembers: councilMembers.split("\n").map((m) => m.trim()).filter(Boolean),
            councilVetoThresholdPercent: Number(vetoPercent),
          }
        : {}),
      ...(mode === "sovereign" && sovereignHoldUp !== ""
        ? { sovereignHoldUpSeconds: Number(sovereignHoldUp) }
        : {}),
      ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
      confirmations,
    };
  }, [mode, tier, councilMembers, vetoPercent, sovereignHoldUp, overrideHoldUp, overrideQuorum, confirmations]);

  const validated = useMemo(() => validateLaunchForm(form), [form]);
  const selected = PROTECTIONS.find((p) => p.id === mode)!;
  // Only the DAO options gate the button — an empty name still submits, so
  // the click can route to the wallet modal / show the field error rather
  // than leaving a dead disabled button with no explanation.
  const daoBlocked = kind === "dao" && !validated.ok;

  function confirm(key: keyof LaunchFormInput["confirmations"], label: string) {
    return (
      <label className="check">
        <input
          type="checkbox"
          data-testid={`confirm-${key}`}
          checked={confirmations[key] ?? false}
          onChange={(e) => setConfirmations({ ...confirmations, [key]: e.target.checked })}
        />
        <span>{label}</span>
      </label>
    );
  }

  /** Upload the image + metadata when a backend is configured. */
  async function metadataUri(): Promise<string> {
    if (image && apiConfigured()) {
      setSteps((s) => [...s, "Uploading image + metadata…"]);
      const { base64, mime } = await fileToBase64(image);
      const res = await launchpadApi.uploadMetadata({
        name,
        symbol,
        description,
        imageBase64: base64,
        imageMime: mime,
      });
      return res.uri;
    }
    return "https://example.invalid/meta.json";
  }

  async function submit() {
    setError(null);
    setState(null);
    setResult(null);
    setSteps([]);
    setDaoSteps([]);
    if (!wallet || !account) {
      openModal();
      return;
    }
    if (!name || !symbol) {
      setError("Name and ticker are required.");
      return;
    }
    setBusy(true);
    try {
      const uri = await metadataUri();

      if (kind === "simple") {
        setSteps((s) => [...s, "Creating the coin…"]);
        const signer = makeSigningWallet(wallet, account);
        const { state: st, mint } = await createCoin(
          { name, symbol, uri },
          { connection: getConnection(), wallet: signer, onState: setState },
        );
        if (st.phase === "confirmed") {
          rememberCoin(mint.toBase58());
          router.push(`/coin?mint=${mint.toBase58()}`);
        }
        return;
      }

      if (!validated.ok || !validated.params) return;
      if (!sender) {
        setError("This wallet cannot sign the multi-step DAO ceremony.");
        return;
      }
      const res = await runLaunch(
        getConnection(),
        sender,
        {
          mode,
          tier,
          params: validated.params,
          metadata: { name, symbol, uri },
          ...(devBuy !== "" && Number(devBuy) > 0
            ? { devBuyLamports: BigInt(Math.floor(Number(devBuy) * 1e9)) }
            : {}),
          ...(mode === "council"
            ? {
                council: {
                  members: councilMembers.split("\n").map((m) => m.trim()).filter(Boolean),
                  vetoThresholdPercent: Number(vetoPercent),
                },
              }
            : {}),
          ...(FEE_TREASURY && FEE_LAMPORTS > 0n
            ? { launchFee: { treasury: FEE_TREASURY, lamports: FEE_LAMPORTS } }
            : {}),
        },
        (s) => setDaoSteps((prev) => [...prev.filter((p) => p.step !== s.step), s]),
      );
      rememberCoin(res.mint);
      setResult(res);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="card" style={{ maxWidth: 640, margin: "1.5rem auto" }} data-testid="launch-result">
        <p className="badge" data-state="verified">DAO launched 🎉</p>
        <p>
          Your coin trades on the curve and its creator fees accrue to the
          treasury. Anyone can crank them home; your holders vote on what
          happens next.
        </p>
        <p>
          <a className="button primary" href={`/coin?mint=${result.mint}`} data-testid="open-coin">
            Open the coin
          </a>{" "}
          <a
            className="button"
            href={`/dao?realm=${result.realm}&vault=${result.vault}${
              account ? `&wallet=${account.address}` : ""
            }`}
            data-testid="open-dao-dashboard"
          >
            Open your DAO dashboard
          </a>
        </p>
        <pre className="result">{JSON.stringify(result, null, 2)}</pre>
      </div>
    );
  }

  return (
    <div className="card" style={{ maxWidth: 640, margin: "1.5rem auto" }}>
      <h1>Create a token</h1>

      <div className="protection-row" role="radiogroup" aria-label="Token kind">
        <button
          role="radio"
          aria-checked={kind === "simple"}
          className={`protection-card${kind === "simple" ? " active" : ""}`}
          onClick={() => setKind("simple")}
          data-testid="kind-simple"
        >
          <span className="protection-name">Simple token</span>
          <span className="muted small">
            A coin on the fair curve. You are the creator, so the creator fees
            are yours.
          </span>
        </button>
        <button
          role="radio"
          aria-checked={kind === "dao"}
          className={`protection-card${kind === "dao" ? " active" : ""}`}
          onClick={() => setKind("dao")}
          data-testid="kind-dao"
        >
          <span className="protection-name">DAO token</span>
          <span className="muted small">
            The same coin, but a holder-governed treasury is the creator — the
            fees accrue to it, with no platform keys.
          </span>
        </button>
      </div>

      <form className="launch" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <label className="field"><span>Name</span>
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} data-testid="coin-name" />
        </label>
        <label className="field"><span>Ticker</span>
          <input value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value.toUpperCase())} data-testid="coin-symbol" />
        </label>
        <label className="field"><span>Description</span>
          <textarea value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} data-testid="coin-desc" />
        </label>
        <label className="field"><span>Image</span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-testid="coin-image" onChange={(e) => setImage(e.target.files?.[0] ?? null)} />
        </label>
        {!apiConfigured() && (
          <p className="muted small">Image upload needs the backend API; the coin still launches without one.</p>
        )}

        {kind === "dao" && (
          <div data-testid="dao-options">
            <h2>Protection</h2>
            <div className="protection-row" role="radiogroup" aria-label="Protection level">
              {PROTECTIONS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={mode === p.id}
                  className={`protection-card${mode === p.id ? " active" : ""}${p.danger ? " danger" : ""}`}
                  onClick={() => setMode(p.id)}
                  data-testid={`protection-${p.id}`}
                >
                  <span className="protection-name">
                    {p.name}
                    {p.badge && <span className="badge" data-state="verified"> {p.badge}</span>}
                  </span>
                  <span className="muted small">{p.copy}</span>
                </button>
              ))}
            </div>
            <ul className="protection-detail" data-testid="protection-detail">
              {selected.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>

            {mode === "council" && (
              <>
                <label className="field"><span>Council members (one wallet address per line, fixed at launch)</span>
                  <textarea rows={4} value={councilMembers} onChange={(e) => setCouncilMembers(e.target.value)} data-testid="council-members" />
                </label>
                <label className="field"><span>Veto threshold: {vetoPercent}%</span>
                  <input type="range" min={1} max={100} value={vetoPercent} onChange={(e) => setVetoPercent(e.target.value)} data-testid="veto-percent" />
                </label>
              </>
            )}

            {mode === "cypherpunk" &&
              confirm("noVetoIrreversible", "I understand: no veto, and every passed vote is irreversible.")}

            {mode === "sovereign" && (
              <>
                <label className="field"><span>Delay before a passed vote can execute (seconds — 0 is allowed, that is the point)</span>
                  <input type="number" min={0} value={sovereignHoldUp} onChange={(e) => setSovereignHoldUp(e.target.value)} data-testid="sovereign-holdup" />
                </label>
                {confirm("noVeto", "I understand: there is no veto.")}
                {confirm("canDrainImmediately", "I understand: this DAO can drain itself the moment a vote passes.")}
              </>
            )}

            <h2>Size</h2>
            <div className="protection-row" role="radiogroup" aria-label="Size">
              {TIERS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={tier === t.id}
                  className={`protection-card${tier === t.id ? " active" : ""}`}
                  onClick={() => setTier(t.id)}
                  data-testid={`tier-${t.id}`}
                >
                  <span className="protection-name">{t.label}</span>
                  <span className="muted small">{t.blurb}</span>
                </button>
              ))}
            </div>
            {validated.params && (
              <p className="muted small" data-testid="resolved-params">
                Quorum {validated.params.quorumPercent}% · delay before execution{" "}
                {hours(validated.params.holdUpSeconds)} ·{" "}
                {validated.params.vetoEnabled ? "council veto enabled" : "no veto"}
              </p>
            )}

            <label className="field"><span>Optional dev buy at launch (SOL)</span>
              <input type="number" min={0} step="0.1" value={devBuy} onChange={(e) => setDevBuy(e.target.value)} data-testid="dev-buy" />
            </label>

            <button type="button" className="preset" onClick={() => setAdvanced((a) => !a)} data-testid="toggle-advanced">
              {advanced ? "Hide advanced" : "Advanced"}
            </button>
            {advanced && (
              <>
                <label className="field"><span>Execution delay override in seconds (stricter than the floor only)</span>
                  <input type="number" value={overrideHoldUp} onChange={(e) => setOverrideHoldUp(e.target.value)} data-testid="override-holdup" />
                </label>
                <label className="field"><span>Quorum override %(stricter than the floor only)</span>
                  <input type="number" value={overrideQuorum} onChange={(e) => setOverrideQuorum(e.target.value)} data-testid="override-quorum" />
                </label>
              </>
            )}

            {!validated.ok && validated.errors.length > 0 && (
              <div className="errors" data-testid="form-errors">
                {validated.errors.map((e) => (<div key={e}>{e}</div>))}
              </div>
            )}
          </div>
        )}

        <button className="button primary" type="submit" disabled={busy || daoBlocked} data-testid="launch-submit">
          {busy ? "Working…" : !wallet ? "Connect wallet" : kind === "dao" ? "Launch DAO token" : "Create token"}
        </button>
      </form>

      <ul className="steps">
        {steps.map((s, i) => (<li key={i}>{s}</li>))}
        {daoSteps.map((s) => (
          <li key={s.step} data-testid={`step-${s.step}`}>
            {s.status === "done" ? "✅" : s.status === "error" ? "❌" : "⏳"} {s.step}
            {s.error ? ` — ${s.error}` : ""}
          </li>
        ))}
      </ul>
      {state && state.phase !== "confirmed" && (
        <p className="status" data-phase={state.phase === "failed" ? "error" : state.phase}>
          {state.phase === "failed" ? `❌ ${state.message ?? state.reason}` : `⏳ ${state.phase}…`}
        </p>
      )}
      {state?.phase === "confirmed" && state.signature && (
        <p className="status" data-phase="done">✅ Launched — <a href={explorerTx(state.signature)} target="_blank" rel="noreferrer">view</a></p>
      )}
      {error && <div className="errors">{error}</div>}
    </div>
  );
}
