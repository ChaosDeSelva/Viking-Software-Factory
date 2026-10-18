import { afterEach, describe, expect, it, vi } from "vitest";
import { applyTheme, loadThemePref, resolveTheme, saveThemePref } from "./theme.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove("dark");
});

function stubScheme(dark: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q.includes("dark") ? dark : false,
    media: q,
  }));
}

describe("theme", () => {
  it("defaults to the shared light appearance", () => {
    expect(loadThemePref()).toBe("light");
  });

  it("persists an explicit preference", () => {
    saveThemePref("dark");
    expect(loadThemePref()).toBe("dark");
  });

  it("ignores garbage stored values", () => {
    localStorage.setItem("mimir.theme", "purple");
    expect(loadThemePref()).toBe("light");
  });

  it("resolves system via prefers-color-scheme", () => {
    stubScheme(true);
    expect(resolveTheme("system")).toBe("dark");
    stubScheme(false);
    expect(resolveTheme("system")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("applies the dark class to the root element", () => {
    stubScheme(false);
    applyTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    applyTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
