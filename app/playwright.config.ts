import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:3210" },
  webServer: [
    {
      command: "npx tsx e2e/stub-server.ts",
      url: "http://127.0.0.1:4404/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npx next dev -p 3210",
      url: "http://127.0.0.1:3210",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { API_URL: "http://127.0.0.1:4404" },
    },
  ],
});
