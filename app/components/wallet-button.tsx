"use client";

/**
 * The persistent top-right wallet control. Disconnected: a "Connect Wallet"
 * button that opens the universal modal. Connected: the wallet icon + a
 * truncated address with a dropdown (copy full address, switch wallet,
 * disconnect). Present on every page via the root layout.
 */
import { useEffect, useRef, useState } from "react";
import { useWallet } from "./wallet-provider";
import { truncateAddress } from "../lib/wallet-registry";

export function WalletButton() {
  const { wallet, account, connectedName, connecting, openModal, disconnect } =
    useWallet();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  if (!account) {
    return (
      <button
        className="button wallet-connect"
        type="button"
        data-testid="connect-wallet"
        disabled={connecting}
        onClick={openModal}
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard?.writeText(account!.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — the full address is shown in the menu */
    }
  }

  return (
    <div className="wallet-menu" ref={ref}>
      <button
        className="button wallet-connected"
        type="button"
        data-testid="wallet-button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        {wallet?.icon ? (
          <img
            className="wallet-icon-sm"
            src={wallet.icon}
            alt=""
            width={18}
            height={18}
          />
        ) : (
          <span className="wallet-icon-sm wallet-icon-letter" aria-hidden="true">
            {(connectedName ?? "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <span data-testid="wallet-button-address">
          {truncateAddress(account.address)}
        </span>
      </button>
      {menuOpen && (
        <div className="wallet-dropdown" role="menu">
          <p className="wallet-dropdown-addr" data-testid="wallet-full-address">
            {account.address}
          </p>
          <button
            type="button"
            role="menuitem"
            className="wallet-dropdown-item"
            onClick={() => void copy()}
          >
            {copied ? "Copied!" : "Copy address"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="wallet-dropdown-item"
            onClick={() => {
              openModal();
              setMenuOpen(false);
            }}
          >
            Change wallet
          </button>
          <button
            type="button"
            role="menuitem"
            className="wallet-dropdown-item"
            data-testid="disconnect-wallet"
            onClick={() => {
              void disconnect();
              setMenuOpen(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
