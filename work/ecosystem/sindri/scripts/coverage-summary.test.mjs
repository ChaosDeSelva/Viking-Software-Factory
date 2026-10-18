// Unit tests for scripts/coverage-summary.mjs: per-package aggregation of Vitest's json-summary.
import { describe, expect, it } from "vitest";
import { formatPackageTable, packageOf, summarizeByPackage } from "./coverage-summary.mjs";

const metric = (total, covered) => ({ total, covered, skipped: 0, pct: 0 });
const file = (s, b, f, l) => ({
  statements: metric(...s),
  branches: metric(...b),
  functions: metric(...f),
  lines: metric(...l),
});

describe("packageOf", () => {
  it("maps a source path to its workspace package directory", () => {
    expect(packageOf("/r/packages/delivery/src/a.ts", "/r")).toBe("packages/delivery");
    expect(packageOf("/r/apps/server/src/x/y.ts", "/r")).toBe("apps/server");
  });
  it("returns undefined for files outside apps/ and packages/", () => {
    expect(packageOf("/r/scripts/a.mjs", "/r")).toBeUndefined();
    expect(packageOf("/elsewhere/packages/a/src/b.ts", "/r")).toBeUndefined();
  });
});

describe("summarizeByPackage", () => {
  it("sums totals per package and recomputes percentages (ignores the 'total' key)", () => {
    const summary = {
      total: file([999, 1], [1, 1], [1, 1], [1, 1]),
      "/r/packages/a/src/one.ts": file([10, 5], [4, 1], [2, 2], [10, 5]),
      "/r/packages/a/src/two.ts": file([10, 10], [0, 0], [2, 0], [10, 10]),
      "/r/apps/server/src/s.ts": file([3, 3], [2, 2], [1, 1], [3, 3]),
    };
    const out = summarizeByPackage(summary, "/r");
    expect(Object.keys(out).sort()).toEqual(["apps/server", "packages/a"]);
    expect(out["packages/a"]).toEqual({
      statements: { total: 20, covered: 15, pct: 75 },
      branches: { total: 4, covered: 1, pct: 25 },
      functions: { total: 4, covered: 2, pct: 50 },
      lines: { total: 20, covered: 15, pct: 75 },
      files: 2,
    });
    expect(out["apps/server"]?.lines.pct).toBe(100);
  });
  it("reports 100% when a metric has no total (matches Vitest)", () => {
    const out = summarizeByPackage(
      { "/r/packages/a/src/t.ts": file([0, 0], [0, 0], [0, 0], [0, 0]) },
      "/r",
    );
    expect(out["packages/a"]?.branches.pct).toBe(100);
  });
  it("rounds percentages to two decimals", () => {
    const out = summarizeByPackage(
      { "/r/packages/a/src/t.ts": file([3, 1], [3, 2], [3, 1], [3, 1]) },
      "/r",
    );
    expect(out["packages/a"]?.statements.pct).toBe(33.33);
    expect(out["packages/a"]?.branches.pct).toBe(66.67);
  });
});

describe("formatPackageTable", () => {
  it("renders one aligned row per package, sorted, with a header", () => {
    const out = summarizeByPackage(
      {
        "/r/packages/b/src/t.ts": file([4, 3], [2, 1], [1, 1], [4, 3]),
        "/r/apps/a/src/t.ts": file([1, 1], [1, 1], [1, 1], [1, 1]),
      },
      "/r",
    );
    const lines = formatPackageTable(out).split("\n");
    expect(lines[0]).toMatch(/^package\s+stmts\s+branch\s+funcs\s+lines\s+files$/);
    expect(lines[2]).toMatch(/^apps\/a\s+100\.00\s+100\.00\s+100\.00\s+100\.00\s+1$/);
    expect(lines[3]).toMatch(/^packages\/b\s+75\.00\s+50\.00\s+100\.00\s+75\.00\s+1$/);
  });
});
