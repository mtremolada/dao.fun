import { defineConfig } from "@playwright/test";

// Serverless app: no backend to stand up. The e2e exercises the static SPA
// (wallet connect, client routing, the shared-contract launch form) without
// touching an RPC — chain reads are bypassed with query overrides.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:3210" },
  webServer: {
    command: "npx next dev -p 3210",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
