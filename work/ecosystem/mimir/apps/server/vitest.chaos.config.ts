import { defineConfig } from "vitest/config";

// `pnpm chaos`: the adversarial chaos and security suites. Files run one at a time because the
// chaos files spawn, SIGKILL and restart real server processes and time server responsiveness.
export default defineConfig({
  cacheDir: "node_modules/.vite",
  test: {
    include: ["test/chaos/**/*.test.ts", "test/security/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
