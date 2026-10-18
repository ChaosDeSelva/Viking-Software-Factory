import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

describe("@sindri/director", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@sindri/director");
  });
});

describe("@sindri/director exports", () => {
  it("exposes the director, providers and helpers", async () => {
    const mod = await import("./index.js");
    for (const name of [
      "openDirector",
      "AnthropicProvider",
      "FakeProvider",
      "NullProvider",
      "createProvider",
      "detectInjection",
      "DIRECTOR_MIGRATIONS",
    ]) {
      expect(mod).toHaveProperty(name);
    }
  });
});
