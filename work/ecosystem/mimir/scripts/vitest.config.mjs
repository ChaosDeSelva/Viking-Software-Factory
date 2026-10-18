import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "node_modules/.vite-release",
  test: { include: ["scripts/**/*.test.mjs"], testTimeout: 280_000 },
});
