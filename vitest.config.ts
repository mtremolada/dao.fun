import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

// Root config covers scripts/ and cross-package tests in tests/.
// Package-local suites run via their own workspace scripts.
export default defineConfig({
  resolve: {
    alias: {
      // The ESM build of @pump-fun/pump-sdk@1.36.0 is broken (its transitive
      // dependency @pump-fun/agent-payments-sdk ships malformed ESM). Pin the
      // CJS entry, which is intact. See DECISIONS.md D-002.
      "@pump-fun/pump-sdk": require.resolve("@pump-fun/pump-sdk"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    // Each file here stands up a whole Solana runtime and loads several
    // 400 KB+ mainnet binaries into it. Running one per core is already
    // heavy; letting vitest fan out further made `beforeAll` occasionally
    // blow its hook timeout under CPU contention — a flake that looks like
    // a real failure and trains you to re-run instead of read. Cap the pool
    // at half the cores so a green run means green.
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: { maxForks: Math.max(2, Math.floor((globalThis.process?.availableParallelism?.() ?? 4) / 2)) },
    },
  },
});
