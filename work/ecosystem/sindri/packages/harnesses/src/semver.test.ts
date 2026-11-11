import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "./semver.js";

describe("parseVersion", () => {
  it("parses x.y.z and rejects anything else", () => {
    expect(parseVersion("1.20.3")).toEqual([1, 20, 3]);
    for (const v of ["1.2", "1.2.3-beta", "v1.2.3", "", "1.2.3 "]) expect(parseVersion(v)).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });

  it("names the operand that is not a version", () => {
    expect(() => compareVersions("x", "1.0.0")).toThrow("not a semver version: x");
    expect(() => compareVersions("1.0.0", "y")).toThrow("not a semver version: y");
  });
});

describe("satisfies", () => {
  it.each([
    ["1.2.3", "*", true],
    ["1.2.3", "1.2.3", true],
    ["1.2.4", "1.2.3", false],
    ["1.9.0", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["1.2.2", "^1.2.3", false],
    ["0.2.9", "^0.2.3", true],
    ["0.3.0", "^0.2.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["0.0.9", "~0.0.3", true],
    // npm semver (what Brokkr uses): ^0.0.z is exactly 0.0.z.
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["0.1.0", "^0.0.3", false],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("never matches a version that is not x.y.z", () => {
    expect(satisfies("1.2", "*")).toBe(false);
  });

  it("returns undefined for unsupported range syntax", () => {
    for (const r of ["^1", ">=1.0.0", "1.x", "~1.2"]) expect(satisfies("1.2.3", r)).toBeUndefined();
  });
});
