import { describe, expect, it } from "vitest";
import { migrateLegacyTheme } from "./theme.js";

describe("migrateLegacyTheme", () => {
  it("moves an explicit Mimir choice to the shared key once", () => {
    localStorage.setItem("mimir.theme", "dark");
    migrateLegacyTheme();
    expect(localStorage.getItem("factory-theme")).toBe("dark");
    expect(localStorage.getItem("mimir.theme")).toBeNull();
  });

  it("treats system and garbage as the shared default (no key)", () => {
    for (const v of ["system", "purple"]) {
      localStorage.setItem("mimir.theme", v);
      migrateLegacyTheme();
      expect(localStorage.getItem("factory-theme")).toBeNull();
    }
  });

  it("never overrides a choice already made in another factory app", () => {
    localStorage.setItem("factory-theme", "light");
    localStorage.setItem("mimir.theme", "dark");
    migrateLegacyTheme();
    expect(localStorage.getItem("factory-theme")).toBe("light");
  });
});
