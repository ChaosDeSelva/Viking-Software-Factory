import { describe, expect, it } from "vitest";
import { MAX_JSON_DEPTH, assertJsonDepth, jsonDepth } from "./json-depth.js";

const nested = (depth: number): unknown => {
  let v: unknown = [];
  for (let i = 1; i < depth; i++) v = [v];
  return v;
};

describe("jsonDepth", () => {
  it("counts object and array nesting; scalars are depth 0", () => {
    expect(jsonDepth("x")).toBe(0);
    expect(jsonDepth({})).toBe(1);
    expect(jsonDepth({ a: [1, { b: null }] })).toBe(3);
    expect(jsonDepth(nested(64))).toBe(64);
  });

  it("handles 1e6 levels without recursion and stops early past the limit", () => {
    expect(jsonDepth(nested(1_000_000), 64)).toBe(65);
  });
});

describe("assertJsonDepth", () => {
  it("accepts MAX_JSON_DEPTH (64) levels and refuses 65 with validation_failed", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
    expect(() => assertJsonDepth(nested(64), "payload")).not.toThrow();
    expect(() => assertJsonDepth(nested(65), "payload")).toThrow(
      expect.objectContaining({ code: "validation_failed" }),
    );
  });
});
