import { defineConfig } from "vitest/config";

// Root config covers scripts/ and cross-package tests in tests/.
// Package-local suites run via their own workspace scripts.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
