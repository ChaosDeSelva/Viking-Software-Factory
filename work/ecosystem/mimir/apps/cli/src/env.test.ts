import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT_CONFIG, EXIT_INFRA, EXIT_OK, dataDir, dbPath, tokenPath } from "./env.js";

afterEach(() => vi.unstubAllEnvs());

describe("dataDir", () => {
  it("prefers MIMIR_DATA_DIR over HOME", () => {
    expect(dataDir({ MIMIR_DATA_DIR: "/x/data", HOME: "/x/home" })).toBe("/x/data");
  });
  it("falls back to <HOME>/.mimir when MIMIR_DATA_DIR is unset or empty", () => {
    expect(dataDir({ HOME: "/x/home" })).toBe("/x/home/.mimir");
    expect(dataDir({ MIMIR_DATA_DIR: "", HOME: "/x/home" })).toBe("/x/home/.mimir");
  });
  it("falls back to the OS home when HOME is unset or empty", () => {
    expect(dataDir({})).toBe(join(homedir(), ".mimir"));
    expect(dataDir({ HOME: "" })).toBe(join(homedir(), ".mimir"));
  });
  it("reads process.env by default", () => {
    vi.stubEnv("MIMIR_DATA_DIR", "/x/from-process-env");
    expect(dataDir()).toBe("/x/from-process-env");
  });
});

describe("paths and errors", () => {
  it("places the token and the event store inside the data dir", () => {
    expect(tokenPath("/d")).toBe("/d/auth-token");
    expect(dbPath("/d")).toBe("/d/mimir.db");
  });
  it("CliError carries its exit code and is an Error", () => {
    const e = new CliError("bad flag", EXIT_CONFIG);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe("bad flag");
    expect(e.exitCode).toBe(2);
    expect([EXIT_OK, EXIT_CONFIG, EXIT_INFRA]).toEqual([0, 2, 3]);
  });
});
