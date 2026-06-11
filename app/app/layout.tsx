import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "dao.fun — launch a DAO around a pump token",
  description:
    "PumpFun DAO launchpad: predicted-PDA custody, no platform keys.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <a href="/" className="brand">
            dao.fun
          </a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
