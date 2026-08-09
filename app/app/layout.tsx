import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { WalletProvider } from "../components/wallet-provider";
import { WalletButton } from "../components/wallet-button";
import { DevnetBanner } from "../components/devnet-banner";

export const metadata: Metadata = {
  title: "dao.fun — launchpad + DAO governance on Solana",
  description:
    "Launch a coin on a fair bonding curve that graduates to Raydium, optionally governed by a DAO with no platform keys.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <DevnetBanner />
          <header className="site-header">
            <Link href="/" className="brand">
              dao.fun
            </Link>
            <nav className="site-nav">
              <Link href="/">Board</Link>
              <Link href="/create">Create</Link>
            </nav>
            <WalletButton />
          </header>
          <main>{children}</main>
          <footer className="site-footer">
            <Link href="/disclaimer">Disclaimer</Link>
            <span className="muted">Experimental software · Solana Devnet · tokens have no value</span>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
