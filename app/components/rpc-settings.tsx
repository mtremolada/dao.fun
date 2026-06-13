"use client";

/**
 * RPC chooser (D-033). The server-less app reads the chain from whatever RPC
 * the user picks; this persists their choice to localStorage so the
 * deployment is permissionless — no shared backend, bring your own endpoint.
 */
import { useEffect, useState } from "react";
import { DEFAULT_RPC_URL, getRpcUrl, setRpcUrl } from "../lib/rpc";

export function RpcSettings() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setValue(getRpcUrl());
  }, []);

  function save() {
    setRpcUrl(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <details className="rpc-settings">
      <summary className="muted" data-testid="rpc-summary">
        RPC endpoint (reads come from here — bring your own)
      </summary>
      <p className="muted" style={{ wordBreak: "break-all" }}>
        Default: {DEFAULT_RPC_URL}
      </p>
      <input
        type="text"
        data-testid="rpc-input"
        value={value}
        placeholder={DEFAULT_RPC_URL}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: "100%", maxWidth: 520 }}
      />{" "}
      <button
        className="button"
        type="button"
        data-testid="rpc-save"
        onClick={save}
      >
        Use this RPC
      </button>
      {saved && <span className="muted" data-testid="rpc-saved"> saved ✓</span>}
    </details>
  );
}
