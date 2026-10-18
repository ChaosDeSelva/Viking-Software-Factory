import { describe, expect, it } from "vitest";
import { coverageArgs, thresholdFor } from "./coverage-args.mjs";

const defaults = { exclude: ["src/**/*.test.ts", "dist/**"] };

describe("coverageArgs", () => {
  it("emits text, lcov and json-summary reporters into a per-package directory", () => {
    const a = coverageArgs("packages/runner", {}, defaults, "/out");
    expect(a).toContain("--coverage.reporter=text");
    expect(a).toContain("--coverage.reporter=lcov");
    expect(a).toContain("--coverage.reporter=json-summary");
    expect(a).toContain("--coverage.reportsDirectory=/out/packages-runner");
  });
  it("merges default and per-package excludes", () => {
    const a = coverageArgs("packages/sdk", { exclude: ["src/types.ts"] }, defaults, "/out");
    expect(a).toContain("--coverage.exclude=src/**/*.test.ts");
    expect(a).toContain("--coverage.exclude=src/types.ts");
  });
  it("adds all four thresholds only for packages that define them", () => {
    expect(coverageArgs("x", {}, defaults, "/o").some((x) => x.includes("thresholds"))).toBe(false);
    const a = coverageArgs(
      "x",
      { thresholds: { statements: 1, branches: 2, functions: 3, lines: 4 } },
      defaults,
      "/o",
    );
    expect(a).toContain("--coverage.thresholds.statements=1");
    expect(a).toContain("--coverage.thresholds.branches=2");
    expect(a).toContain("--coverage.thresholds.functions=3");
    expect(a).toContain("--coverage.thresholds.lines=4");
  });
});

describe("thresholdFor", () => {
  it("is measured minus two points, floored", () => {
    expect(thresholdFor(99.41)).toBe(97);
    expect(thresholdFor(80.18)).toBe(78);
    expect(thresholdFor(1)).toBe(0);
  });
});
