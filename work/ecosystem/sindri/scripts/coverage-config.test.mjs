// Guards the coverage gate: every core package keeps all four thresholds, and test/fixture
// files never count as covered source.
import { describe, expect, it } from "vitest";
import config from "../vitest.coverage.config.mjs";

const CORE = [
  "packages/delivery",
  "packages/director",
  "packages/knowledge",
  "packages/intake",
  "apps/server",
];
const coverage = config.test.coverage;

describe("vitest.coverage.config.mjs", () => {
  it.each(CORE)("enforces statements/branches/functions/lines thresholds for %s", (pkg) => {
    const t = coverage.thresholds?.[`${pkg}/src/**`];
    expect(t).toBeDefined();
    for (const m of ["statements", "branches", "functions", "lines"]) {
      expect(typeof t[m]).toBe("number");
      expect(t[m]).toBeGreaterThan(0);
    }
  });

  it("writes text, lcov and json-summary into coverage/", () => {
    expect(coverage.reportsDirectory).toBe("coverage");
    expect(coverage.reporter).toEqual(expect.arrayContaining(["text", "lcov", "json-summary"]));
  });

  it("excludes tests, fixtures, dist and declaration files", () => {
    expect(coverage.exclude).toEqual(
      expect.arrayContaining(["**/dist/**", "**/*.test.{ts,tsx}", "**/fixtures/**", "**/*.d.ts"]),
    );
  });
});
