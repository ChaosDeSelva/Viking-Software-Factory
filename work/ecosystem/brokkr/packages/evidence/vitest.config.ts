import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// These tests spawn real processes (git, node); allow for a loaded machine.
// Runs and the signing key live under BROKKR_HOME: never the real ~/.brokkr in tests.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    testTimeout: 30_000,
    env: { BROKKR_HOME: mkdtempSync(join(tmpdir(), "brokkr-test-home-")) },
  },
});
