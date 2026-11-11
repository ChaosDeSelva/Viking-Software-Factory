import { homedir } from "node:os";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, dataDir, dbPath, EXIT_CONFIG, EXIT_INFRA, tokenPath } from "./env.js";
import { init, showToken } from "./init.js";

let home: string;
let data: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-init-"));
  data = join(home, "data");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const env = (): NodeJS.ProcessEnv => ({ HOME: home, SINDRI_DATA_DIR: data });

describe("env", () => {
  it("resolves the data dir from SINDRI_DATA_DIR, then HOME, then the OS home", () => {
    expect(dataDir({ SINDRI_DATA_DIR: "/x", HOME: "/h" })).toBe("/x");
    expect(dataDir({ SINDRI_DATA_DIR: "", HOME: "/h" })).toBe(join("/h", ".sindri"));
    expect(dataDir({ HOME: "" })).toBe(join(homedir(), ".sindri"));
    expect(tokenPath("/d")).toBe(join("/d", "auth-token"));
    expect(dbPath("/d")).toBe(join("/d", "sindri.db"));
  });
});

describe("init", () => {
  it("creates a 0700 data dir, config.json and a 0600 token, then reports it as present", () => {
    const a = init(env());
    expect(a).toEqual({
      dataDir: data,
      configPath: join(data, "config.json"),
      tokenPath: join(data, "auth-token"),
      tokenCreated: true,
    });
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(a.configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(a.configPath, "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 7800,
    });
    const token = readFileSync(a.tokenPath, "utf8");
    expect(init(env()).tokenCreated).toBe(false);
    expect(readFileSync(a.tokenPath, "utf8")).toBe(token);
  });

  it("wraps file system failures as exit 3", () => {
    writeFileSync(join(home, "file"), "x");
    const e = (() => {
      try {
        init({ SINDRI_DATA_DIR: join(home, "file", "data") });
      } catch (err) {
        return err as CliError;
      }
      throw new Error("expected a failure");
    })();
    expect(e).toBeInstanceOf(CliError);
    expect(e.exitCode).toBe(EXIT_INFRA);
    expect(e.message).toContain(`cannot initialise ${join(home, "file", "data")}`);
  });
});

describe("showToken", () => {
  it("prints the trimmed token, and exits 2 before init", () => {
    expect(() => showToken(env())).toThrow(/run `sindri init`/);
    try {
      showToken(env());
    } catch (e) {
      expect((e as CliError).exitCode).toBe(EXIT_CONFIG);
    }
    mkdirSync(data);
    writeFileSync(join(data, "auth-token"), "  abc  \n");
    expect(showToken(env())).toBe("abc");
  });
});
