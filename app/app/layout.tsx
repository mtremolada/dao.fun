import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";
import { WalletProvider } from "../components/wallet-provider";
import { WalletButton } from "../components/wallet-button";

export const metadata: Metadata = {
  title: "dao.fun — launch a DAO around a pump token",
  description:
    "PumpFun DAO launchpad: predicted-PDA custody, no platform keys.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="site-header">
            <Link href="/" className="brand">
              dao.fun
            </Link>
            <WalletButton />
          </header>
          <main>{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
