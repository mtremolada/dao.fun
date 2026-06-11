import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

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
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
