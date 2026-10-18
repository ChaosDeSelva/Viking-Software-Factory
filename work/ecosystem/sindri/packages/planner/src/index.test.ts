import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@sindri/planner", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sindri/planner");
  });
});
