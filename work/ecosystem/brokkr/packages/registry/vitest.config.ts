import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// The repo-level built-in harness library test lives in ../../tests and runs with this package.
// Tarball tests shell out to tar; 30 s keeps them stable on a loaded machine.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: { include: ["src/**/*.test.ts", "../../tests/*.test.ts"], testTimeout: 30_000 },
});
