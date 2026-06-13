import type { Metadata } from "next";
import type { ReactNode } from "react";
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
            <a href="/" className="brand">
              dao.fun
            </a>
            <WalletButton />
          </header>
          <main>{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
