import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { WalletProvider } from "../components/wallet-provider";
import { WalletButton } from "../components/wallet-button";

export const metadata: Metadata = {
  title: "dao.fun — launch a DAO around a pump token",
  description:
    "Launch a pump.fun token whose creator fees flow to an on-chain, holder-governed treasury — no platform keys in the custody path. Predicted-PDA custody, verifiable on-chain.",
  openGraph: {
    title: "dao.fun — launch a DAO around a pump token",
    description:
      "Creator fees flow to a treasury only the holders can move. No platform keys.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#08080c",
};

/** Gradient brand glyph (inline so it needs no asset path on static hosting). */
function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 32 32"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="bm" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9945ff" />
          <stop offset="100%" stopColor="#14f195" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#bm)" />
      <path
        d="M9 9h6.5a7 7 0 0 1 0 14H9V9Zm4 3.4v7.2h2.5a3.6 3.6 0 0 0 0-7.2H13Z"
        fill="#08080c"
      />
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const year = new Date().getFullYear();
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="site-header">
            <div className="header-left">
              <Link href="/" className="brand">
                <BrandMark />
                <span className="brand-name">
                  <b>dao</b>.fun
                </span>
              </Link>
              <nav className="nav">
                <Link href="/">Modes</Link>
                <Link href="/launch?mode=cypherpunk">Launch</Link>
              </nav>
            </div>
            <WalletButton />
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <span>
              dao.fun · {year} · runs entirely in your browser — no platform keys
            </span>
            <a
              href="https://github.com/mtremolada/dao.fun"
              target="_blank"
              rel="noreferrer"
            >
              source ↗
            </a>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
