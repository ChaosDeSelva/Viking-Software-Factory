import { describe, expect, it } from "vitest";
import { checkThresholds, formatCoverageTable, mergeLcov, totalsOf } from "./coverage-lib.mjs";

const summary = (s, b, f, l) => ({
  total: {
    statements: { pct: s },
    branches: { pct: b },
    functions: { pct: f },
    lines: { pct: l },
  },
});

describe("totalsOf", () => {
  it("reads the four percentages from a json-summary", () => {
    expect(totalsOf(summary(91.2, 80.5, 88, 92.25))).toEqual({
      statements: 91.2,
      branches: 80.5,
      functions: 88,
      lines: 92.25,
    });
  });
});

describe("checkThresholds", () => {
  const thresholds = {
    "packages/core": { statements: 90, branches: 80, functions: 85, lines: 90 },
    "apps/server": { statements: 70, branches: 60, functions: 70, lines: 70 },
  };

  it("passes when every metric is at or above its floor", () => {
    const measured = {
      "packages/core": { statements: 90, branches: 81, functions: 85.1, lines: 95 },
      "apps/server": { statements: 70, branches: 60, functions: 70, lines: 70 },
    };
    expect(checkThresholds(measured, thresholds)).toEqual([]);
  });

  it("reports each metric that fell below its floor", () => {
    const measured = {
      "packages/core": { statements: 89.9, branches: 81, functions: 85, lines: 90 },
      "apps/server": { statements: 70, branches: 59, functions: 70, lines: 69 },
    };
    expect(checkThresholds(measured, thresholds)).toEqual([
      "packages/core statements 89.9% < 90%",
      "apps/server branches 59% < 60%",
      "apps/server lines 69% < 70%",
    ]);
  });

  it("fails a core package that produced no coverage at all", () => {
    expect(checkThresholds({ "packages/core": thresholds["packages/core"] }, thresholds)).toEqual([
      "apps/server: no coverage measured",
    ]);
  });
});

describe("formatCoverageTable", () => {
  it("prints one row per package with its floors for core packages", () => {
    const text = formatCoverageTable(
      {
        "packages/core": { statements: 92.1, branches: 81.04, functions: 90, lines: 93 },
        "packages/sdk": { statements: 50, branches: 40, functions: 30, lines: 51 },
      },
      { "packages/core": { statements: 90, branches: 79, functions: 88, lines: 91 } },
    );
    const lines = text.split("\n");
    expect(lines[0]).toMatch(
      /^package\s+\| stmts\s+\| branches\s+\| funcs\s+\| lines\s+\| floor \(s\/b\/f\/l\)$/,
    );
    expect(lines[2]).toMatch(
      /^packages\/core\s+\| 92\.10\s+\| 81\.04\s+\| 90\.00\s+\| 93\.00\s+\| 90\/79\/88\/91$/,
    );
    expect(lines[3]).toMatch(
      /^packages\/sdk\s+\| 50\.00\s+\| 40\.00\s+\| 30\.00\s+\| 51\.00\s+\| -$/,
    );
  });
});

describe("mergeLcov", () => {
  it("rewrites SF paths to be relative to the repo root and concatenates", () => {
    const merged = mergeLcov("/repo", [
      { dir: "/repo/packages/core", text: "TN:\nSF:src/a.ts\nend_of_record\n" },
      { dir: "/repo/apps/server", text: "TN:\nSF:/repo/apps/server/src/b.ts\nend_of_record\n" },
    ]);
    expect(merged).toBe(
      "TN:\nSF:packages/core/src/a.ts\nend_of_record\nTN:\nSF:apps/server/src/b.ts\nend_of_record\n",
    );
  });
});
