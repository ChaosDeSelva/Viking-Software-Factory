import { defineConfig } from "vitest/config";

// Per-package cache dir; generous timeout because these tests create git
// worktrees and spawn pnpm/node while the whole gate runs in parallel.
export default defineConfig({ cacheDir: "node_modules/.vite", test: { testTimeout: 120_000 } });
