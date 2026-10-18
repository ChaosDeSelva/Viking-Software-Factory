import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// Test files run one at a time: the e2e suite spawns real type checks and process
// trees, which would otherwise distort the CLI startup-time assertion in bin.test.ts.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: { fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 },
});
