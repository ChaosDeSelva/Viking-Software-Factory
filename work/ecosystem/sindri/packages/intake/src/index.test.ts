import { describe, expect, it } from "vitest";
import * as api from "./index.js";

describe("@sindri/intake", () => {
  it("exports its package name", () => {
    expect(api.PACKAGE_NAME).toBe("@sindri/intake");
  });

  it("exposes the public API", () => {
    for (const name of [
      "openIntake",
      "sanitizeForDisplay",
      "JiraConnector",
      "LinearConnector",
      "KeychainSecretStore",
      "EnvSecretStore",
      "FileSecretStore",
      "resolveSecret",
    ] as const) {
      expect(typeof api[name]).toBe("function");
    }
    expect(api.INTAKE_MIGRATIONS.length).toBeGreaterThan(0);
  });
});
