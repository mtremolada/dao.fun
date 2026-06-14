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
    testTimeout: 120_000,
    // The integration suite spins up a solana-bankrun runtime per file; running
    // ~19 in parallel starves the CI runner's CPU and intermittently trips the
    // per-test timeout (a file that passes in <1s alone hangs to the wall under
    // contention). Serialize file execution at the CONFIG level so it holds no
    // matter how the run is invoked. Each file then gets the whole core and the
    // full suite finishes in ~20s.
    fileParallelism: false,
  },
});
