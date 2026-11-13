import { defineConfig } from "vitest/config";

// `pnpm test:timing`: the *.timing.test.ts files only, one file at a time in a single worker, so
// the measurements share the machine with nothing else from this run. The root `pnpm test` runs
// this after all other suites, one package at a time.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    include: ["src/**/*.timing.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
