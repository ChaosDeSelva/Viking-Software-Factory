import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
