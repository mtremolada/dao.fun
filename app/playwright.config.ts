import { defineConfig } from "@playwright/test";

// Server-less (D-033): no backend stub. The app reads the chain and signs in
// the browser; these specs cover the client-side states that need no RPC
// (the proposal override path, launch-form validation, the dashboard
// missing-param guard, wallet connect). Write/read flows that hit a live RPC
// are smoke-tested with a funded wallet after deploy (see DEPLOY.md).
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
