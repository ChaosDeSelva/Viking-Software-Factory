import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
export default defineConfig({ cacheDir: "node_modules/.vite", test: { fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,} });
