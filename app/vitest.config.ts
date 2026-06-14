import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // The sdk's browser-safe subpaths ship as TS SOURCE (no node:crypto, so the
    // static client can bundle them); inline them so vitest transforms the TS
    // instead of require()-ing a .ts file — mirrors the app build's
    // transpilePackages: ["@daofun/sdk"].
    server: { deps: { inline: [/@daofun\/sdk/] } },
  },
});
