import { configDefaults, defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// The process-level chaos suite (spawns, SIGKILLs and restarts servers) runs in `pnpm chaos`.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    exclude: [...configDefaults.exclude, "test/chaos/**"],
    // The orchestration suites spawn git, node and npm per test; capping workers keeps this
    // package from starving the other packages' tests when turbo runs them in parallel.
    maxWorkers: 3,
  },
});
