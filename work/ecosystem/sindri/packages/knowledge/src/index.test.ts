import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@sindri/knowledge", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@sindri/knowledge");
  });

  it("exposes the public API", () => {
    for (const name of ["openKnowledge", "openDatabase", "applyMigrations", "chunkText"] as const) {
      expect(typeof api[name]).toBe("function");
    }
  });
});
