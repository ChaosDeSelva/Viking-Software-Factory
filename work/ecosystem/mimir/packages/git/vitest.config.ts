import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// Git integration tests spawn many processes; allow headroom on a loaded machine.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
