import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Per-package cache dir; generous timeout because these tests spawn git, pnpm and
// node processes and run alongside the whole gate. Runs and the signing key live
// under BROKKR_HOME, never the real ~/.brokkr.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    testTimeout: 30_000,
    env: { BROKKR_HOME: mkdtempSync(join(tmpdir(), "brokkr-sdk-test-home-")) },
  },
});
