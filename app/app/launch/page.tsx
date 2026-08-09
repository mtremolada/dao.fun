"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * /launch merged into /create — a DAO token is a create-page toggle now, not
 * a separate funnel. The redirect is CLIENT-side on purpose: this app is a
 * static export, so a server redirect() would build an error page instead of
 * a hop (verified in app/out). The link is the no-JS fallback.
 */
export default function LaunchPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/create");
  }, [router]);
  return (
    <p className="muted">
      Launching a DAO moved into <Link href="/create">Create a token</Link> —
      pick “DAO token” there. Redirecting…
    </p>
  );
}
