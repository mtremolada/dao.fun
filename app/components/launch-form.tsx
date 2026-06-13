"use client";

/**
 * Launch form — spec 6.7, server-less (D-033). Renders validateLaunchForm
 * results live (the same function the on-chain builders enforce) and then
 * runs the FULL launch ceremony in the browser: connect a wallet, generate
 * the ephemeral keypairs locally, and build/sign/submit every step against
 * the user's RPC. No server, no platform key.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  validateLaunchForm,
  type GovernanceMode,
  type LaunchFormInput,
  type MarketCapTier,
} from "@daofun/sdk/launch-form";
import type { LaunchResult } from "@daofun/sdk";
import {
  connectWallet,
  discoverWallets,
  makeSigner,
} from "../lib/wallet-standard";
import type { SignerLike } from "../lib/governance-actions";
import { getConnection } from "../lib/rpc";
import { runClientLaunch } from "../lib/client-launch";

const TIERS: MarketCapTier[] = ["micro", "small", "mid", "large"];

interface Progress {
  label: string;
  signature: string;
}

export function LaunchForm({ mode }: { mode: GovernanceMode }) {
  const [tier, setTier] = useState<MarketCapTier>("micro");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [devBuy, setDevBuy] = useState("");
  const [councilMembers, setCouncilMembers] = useState("");
  const [vetoPercent, setVetoPercent] = useState("60");
  const [sovereignHoldUp, setSovereignHoldUp] = useState("");
  const [overrideHoldUp, setOverrideHoldUp] = useState("");
  const [overrideQuorum, setOverrideQuorum] = useState("");
  const [confirmations, setConfirmations] = useState<
    LaunchFormInput["confirmations"]
  >({});

  const [signer, setSigner] = useState<SignerLike | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress[]>([]);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [result, setResult] = useState<LaunchResult | null>(null);

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
  const metadataOk = name.trim() !== "" && symbol.trim() !== "" && uri.trim() !== "";
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

  async function connect() {
    try {
      const wallets = discoverWallets();
      if (wallets.length === 0) {
        setConnectError("No wallet found — install a Solana wallet extension.");
        return;
      }
      const account = await connectWallet(wallets[0]!);
      setSigner(makeSigner(wallets[0]!, account));
      setConnectError(null);
    } catch (e) {
      setConnectError((e as Error).message);
    }
  }

  async function launch() {
    if (!signer || !validated.ok || !metadataOk) return;
    setRunning(true);
    setServerErrors([]);
    setProgress([]);
    setResult(null);
    try {
      const res = await runClientLaunch(
        {
          form,
          metadata: { name: name.trim(), symbol: symbol.trim(), uri: uri.trim() },
          ...(devBuy.trim() !== "" ? { devBuyLamports: BigInt(devBuy.trim()) } : {}),
        },
        {
          connection: getConnection(),
          walletAddress: signer.address,
          signTransaction: (tx) => signer.signTransaction(tx),
          onStep: (label, signature) =>
            setProgress((p) => [...p, { label, signature }]),
        },
      );
      setResult(res);
    } catch (e) {
      setServerErrors([(e as Error).message]);
    } finally {
      setRunning(false);
    }
  }

  if (result) {
    const realm = result.treasury.realm.toBase58();
    const vault = result.treasury.vaultPda.toBase58();
    const mint = result.mint.toBase58();
    return (
      <div className="result" data-testid="launch-result">
        <h2>DAO launched ✓</h2>
        <p className="muted" style={{ wordBreak: "break-all" }}>
          mint {mint}
          <br />
          realm {realm}
          <br />
          vault {vault}
        </p>
        <p>
          <Link className="button" href={`/dao/?realm=${realm}&vault=${vault}&mint=${mint}`}>
            Open the DAO dashboard
          </Link>
        </p>
        <p className="muted">
          mint authority null: {String(result.mintAuthorityNull)} · predicted
          PDAs matched: {String(result.predictedPdasMatched)}
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
      <h2>Token</h2>
      <label htmlFor="token-name">Name</label>
      <input
        id="token-name"
        data-testid="token-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="token-symbol">Symbol</label>
      <input
        id="token-symbol"
        data-testid="token-symbol"
        value={symbol}
        onChange={(e) => setSymbol(e.target.value)}
      />
      <label htmlFor="token-uri">
        Metadata URI (the off-chain JSON; e.g. an IPFS link you pinned)
      </label>
      <input
        id="token-uri"
        data-testid="token-uri"
        value={uri}
        onChange={(e) => setUri(e.target.value)}
      />
      <label htmlFor="dev-buy">Optional dev-buy (lamports, 0 to skip)</label>
      <input
        id="dev-buy"
        data-testid="dev-buy"
        type="number"
        min={0}
        value={devBuy}
        onChange={(e) => setDevBuy(e.target.value)}
      />

      <h2>Governance</h2>
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

      {progress.length > 0 && (
        <ol className="result" data-testid="launch-progress">
          {progress.map((p) => (
            <li key={p.label} style={{ wordBreak: "break-all" }}>
              {p.label}: {p.signature}
            </li>
          ))}
        </ol>
      )}

      {!signer ? (
        <>
          <button
            className="button"
            type="button"
            data-testid="connect-wallet-launch"
            onClick={() => void connect()}
          >
            Connect wallet to launch
          </button>
          {connectError && (
            <p className="errors" data-testid="connect-error-launch">
              {connectError}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="muted" data-testid="wallet-address-launch">
            Connected: {signer.address}
          </p>
          <button
            className="button"
            type="submit"
            data-testid="launch-submit"
            disabled={!validated.ok || !metadataOk || running}
          >
            {running ? "Launching…" : "Launch DAO"}
          </button>
        </>
      )}
    </form>
  );
}
