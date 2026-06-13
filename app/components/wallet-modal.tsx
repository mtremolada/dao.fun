"use client";

/**
 * The connect popup — the universal "pick a wallet" dialog every app shows:
 * detected wallet-standard wallets first (with their own brand icons), then
 * a curated install list for popular wallets that aren't present. Backdrop
 * click and Escape close it.
 */
import { useEffect } from "react";
import { useWallet } from "./wallet-provider";
import { installOptions, slugify } from "../lib/wallet-registry";
import type { StandardWalletLike } from "../lib/wallet-standard";

function WalletIcon({
  name,
  icon,
}: {
  name: string;
  icon?: string | undefined;
}) {
  if (icon) {
    // Wallet brand mark is a data-URI the wallet ships; a plain <img> avoids
    // pulling next/image's loader for an inline asset.
    return (
      <img className="wallet-icon" src={icon} alt="" width={28} height={28} />
    );
  }
  return (
    <span className="wallet-icon wallet-icon-letter" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function WalletModal() {
  const { modalOpen, closeModal, wallets, connect, connecting, error } =
    useWallet();

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen, closeModal]);

  if (!modalOpen) return null;
  const installs = installOptions(wallets);

  return (
    <div
      className="wallet-modal-backdrop"
      data-testid="wallet-modal"
      onClick={closeModal}
    >
      <div
        className="wallet-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wallet-modal-head">
          <h2>Connect a wallet</h2>
          <button
            className="wallet-modal-close"
            type="button"
            aria-label="Close"
            data-testid="wallet-modal-close"
            onClick={closeModal}
          >
            ×
          </button>
        </div>

        {wallets.length > 0 ? (
          <ul className="wallet-list">
            {wallets.map((w: StandardWalletLike) => (
              <li key={w.name}>
                <button
                  type="button"
                  className="wallet-option"
                  data-testid={`wallet-option-${slugify(w.name)}`}
                  disabled={connecting}
                  onClick={() => void connect(w.name)}
                >
                  <WalletIcon name={w.name} icon={w.icon} />
                  <span className="wallet-option-name">{w.name}</span>
                  <span className="wallet-tag">Detected</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" data-testid="no-wallets">
            No Solana wallet detected. Install one of these to continue:
          </p>
        )}

        {installs.length > 0 && (
          <>
            {wallets.length > 0 && (
              <p className="wallet-more muted">More wallets</p>
            )}
            <ul className="wallet-list">
              {installs.map((opt) => (
                <li key={opt.name}>
                  <a
                    className="wallet-option"
                    href={opt.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid={`wallet-install-${slugify(opt.name)}`}
                  >
                    <WalletIcon name={opt.name} />
                    <span className="wallet-option-name">{opt.name}</span>
                    <span className="wallet-tag muted">Install</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        {error && (
          <p className="errors" data-testid="wallet-modal-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
