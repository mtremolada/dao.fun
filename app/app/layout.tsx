import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
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
          <Link href="/" className="brand">
            dao.fun
          </Link>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
