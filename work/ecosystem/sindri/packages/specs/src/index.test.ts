import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@sindri/specs", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@sindri/specs");
  });

  it("exposes the public API", () => {
    for (const name of ["openSpecs", "diffSpecs", "renderSpec"] as const) {
      expect(typeof api[name]).toBe("function");
    }
    expect(api.SpecBodySchema.safeParse({}).success).toBe(false);
  });
});
