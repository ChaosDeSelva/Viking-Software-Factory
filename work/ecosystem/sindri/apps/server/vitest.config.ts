import { configDefaults, defineConfig } from "vitest/config";

// Per-package cache dir: parallel turbo runs otherwise race on the shared root cache.
// The server tests start fake Mimir servers and git repos; under a loaded full-repo
// `pnpm check` they hit the 5 s / 10 s defaults (seen on the Ssec2 merge base too), so they get
// the same 60 s budget as the CLI tests. No assertions changed.
// The factory acceptance run needs a sibling Mimir build and minutes: `pnpm test:acceptance`.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    fsModuleCachePath: new URL("./node_modules/.vitest-cache", import.meta.url).pathname,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, "test/acceptance/**"],
  },
});
