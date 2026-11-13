import { configDefaults, defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// *.timing.test.ts measure how work grows with input size; they run alone, after every suite, via
// `pnpm test:timing` (vitest.timing.config.ts), so concurrent tests cannot skew them.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    exclude: [...configDefaults.exclude, "**/*.timing.test.ts"],
  },
});
