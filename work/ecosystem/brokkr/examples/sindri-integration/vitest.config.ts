import { defineConfig } from "vitest/config";

// Per-package cache dir; generous timeout because these tests spawn git, pnpm and
// node processes and run alongside the whole gate.
export default defineConfig({ cacheDir: "node_modules/.vite", test: { testTimeout: 30_000 } });
