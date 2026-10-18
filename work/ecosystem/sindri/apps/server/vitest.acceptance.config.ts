import { defineConfig } from "vitest/config";

// Factory acceptance run against a real Mimir child process (see test/acceptance/).
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: { include: ["test/acceptance/**/*.test.ts"], testTimeout: 900_000, hookTimeout: 60_000 },
});
