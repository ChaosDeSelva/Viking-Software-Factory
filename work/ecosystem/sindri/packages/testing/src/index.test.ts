import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@sindri/testing", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sindri/testing");
  });
});
