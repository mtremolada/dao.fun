import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

// Managed containers pre-install Chromium at a fixed path whose revision may
// not match this Playwright pin; use it when present, else normal resolution.
const PREINSTALLED_CHROMIUM = "/opt/pw-browsers/chromium";

// Serverless app: no backend to stand up. The e2e exercises the static SPA
// (wallet connect, client routing, the shared-contract launch form) without
// touching an RPC — chain reads are bypassed with query overrides.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: {
    baseURL: "http://127.0.0.1:3210",
    ...(existsSync(PREINSTALLED_CHROMIUM)
      ? { launchOptions: { executablePath: PREINSTALLED_CHROMIUM } }
      : {}),
  },
  webServer: {
    // A PRODUCTION build, not `next dev`. The dev server compiles each route
    // on its first request, so with four browser workers racing on a 4-core
    // box the first test to touch a cold route could blow its timeout — a
    // different spec each run, green on re-run, which is exactly the kind of
    // flake that teaches you to stop reading failures. Building once up front
    // removes on-demand compilation entirely, and has the side benefit of
    // exercising the artifact that actually ships rather than a dev bundle.
    // Set E2E_DEV=1 for the fast-feedback dev server while writing specs.
    command: process.env.E2E_DEV
      ? "npx next dev -p 3210"
      : "npx next build && npx next start -p 3210",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
