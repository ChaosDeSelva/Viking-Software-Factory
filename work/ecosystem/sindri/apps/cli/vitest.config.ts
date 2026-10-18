import { defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// Sflaky: the CLI tests spawn processes and hit the 5 s default under a loaded full-repo
// `pnpm check` (review Ssec I4); 60 s matches Mimir's Tflaky fix. No assertions changed.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
