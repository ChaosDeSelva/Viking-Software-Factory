import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@mimir/telemetry", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@mimir/telemetry");
  });
});
