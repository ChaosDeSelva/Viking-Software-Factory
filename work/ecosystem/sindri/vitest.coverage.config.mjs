// pnpm test:coverage: runs every workspace package's own Vitest config as a project and
// collects V8 coverage over the shipped sources only.
//
// Thresholds: per core package, the coverage measured on 2026-10-14 (QA lane, after merging
// main 3800720) minus 2 points, so the gate cannot regress. Raise them as coverage improves; never lower
// them to make a run pass. Measured values are in .sdd/reports/QA-sindri-report.md.
import { defineConfig } from "vitest/config";

const thresholds = {
  // measured: 93.40 / 79.09 / 97.74 / 95.66 (statements / branches / functions / lines)
  "apps/server/src/**": { statements: 91.4, branches: 77.09, functions: 95.74, lines: 93.66 },
  // measured: 94.25 / 83.43 / 97.12 / 96.51
  "packages/delivery/src/**": {
    statements: 92.25,
    branches: 81.43,
    functions: 95.12,
    lines: 94.51,
  },
  // measured: 95.00 / 81.31 / 94.57 / 96.14
  "packages/director/src/**": { statements: 93, branches: 79.31, functions: 92.57, lines: 94.14 },
  // measured: 95.73 / 79.59 / 95.12 / 97.08
  "packages/intake/src/**": { statements: 93.73, branches: 77.59, functions: 93.12, lines: 95.08 },
  // measured: 93.52 / 84.27 / 100.00 / 96.42
  "packages/knowledge/src/**": { statements: 91.52, branches: 82.27, functions: 98, lines: 94.42 },
};

export default defineConfig({
  cacheDir: "node_modules/.vite-coverage",
  test: {
    projects: ["apps/*", "packages/*"],
    // Half the cores: the suites spawn git and child processes, and V8 coverage adds overhead;
    // a full pool on a busy machine pushes them past their default timeouts.
    maxWorkers: "50%",
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "lcov", "json-summary"],
      reportOnFailure: true,
      thresholds,
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      exclude: [
        "**/dist/**",
        "**/*.test.{ts,tsx}",
        "**/__tests__/**",
        "**/test/**",
        "**/fixtures/**",
        "**/*.d.ts",
      ],
    },
  },
});
