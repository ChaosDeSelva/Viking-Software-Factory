import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "node_modules/.vite-scripts",
  test: { include: ["scripts/**/*.test.mjs"], testTimeout: 120_000 },
});
