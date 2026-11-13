import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// The tests boot fake Mimir HTTP servers and SQLite: ~100 ms each locally, but one passed the 5 s
// default on a loaded macOS CI runner (2026-11-13), so they get 30 s. No assertions changed.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    testTimeout: 30_000,
  },
});
