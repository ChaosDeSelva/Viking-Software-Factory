import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// Each test builds a git repo and resolves the built-in harness library (digests): seconds under load.
export default defineConfig({ cacheDir: "node_modules/.vite", test: { testTimeout: 60_000 } });
