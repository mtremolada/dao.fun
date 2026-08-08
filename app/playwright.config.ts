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
    command: "npx next dev -p 3210",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
