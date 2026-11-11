import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./env.js";
import { init, showToken } from "./init.js";

let home: string;
let data: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-init-"));
  data = join(home, "nested", "data");
  env = { HOME: home, MIMIR_DATA_DIR: data };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const cliError = (fn: () => unknown): CliError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CliError);
    return e as CliError;
  }
  throw new Error("expected a CliError");
};

describe("init", () => {
  it("creates a 0700 data dir, a 0600 random token and config.json", () => {
    const r = init(env);
    expect(r).toEqual({ dataDir: data, tokenPath: join(data, "auth-token"), tokenCreated: true });
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(statSync(r.tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(join(data, "config.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(data, "config.json"), "utf8"))).toEqual({
      host: "127.0.0.1",
      port: 7700,
      dataDir: data,
      herdrSession: "mimir",
    });
  });

  it("keeps an existing token and config, and tightens a loose token mode", () => {
    const first = init(env);
    const token = readFileSync(first.tokenPath, "utf8");
    writeFileSync(join(data, "config.json"), '{"port":9}');
    chmodSync(first.tokenPath, 0o644);
    const second = init(env);
    expect(second.tokenCreated).toBe(false);
    expect(readFileSync(first.tokenPath, "utf8")).toBe(token);
    expect(statSync(first.tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe('{"port":9}');
  });

  it("generates different tokens for different data dirs", () => {
    const a = init(env);
    const b = init({ HOME: home, MIMIR_DATA_DIR: join(home, "other") });
    expect(readFileSync(a.tokenPath, "utf8")).not.toBe(readFileSync(b.tokenPath, "utf8"));
  });

  it("replaces an empty token file instead of reporting it as present", () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "auth-token"), "\n", { mode: 0o644 });
    const r = init(env);
    expect(r.tokenCreated).toBe(true);
    expect(readFileSync(r.tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(r.tokenPath).mode & 0o777).toBe(0o600);
  });

  it("fails with exit 3 and names the data dir when it cannot be created", () => {
    writeFileSync(join(home, "file"), "x");
    const dir = join(home, "file", "sub");
    const e = cliError(() => init({ HOME: home, MIMIR_DATA_DIR: dir }));
    expect(e.exitCode).toBe(3);
    expect(e.message).toContain(`cannot initialise ${dir}`);
  });

  it("uses process.env by default", () => {
    vi.stubEnv("MIMIR_DATA_DIR", data);
    expect(init().dataDir).toBe(data);
  });
});

describe("showToken", () => {
  it("returns the trimmed token file", () => {
    const r = init(env);
    expect(showToken(env)).toBe(readFileSync(r.tokenPath, "utf8").trim());
  });
  it("prefers MIMIR_AUTH_TOKEN, and ignores it when empty", () => {
    init(env);
    expect(showToken({ ...env, MIMIR_AUTH_TOKEN: "from-env-0123456789" })).toBe(
      "from-env-0123456789",
    );
    expect(showToken({ ...env, MIMIR_AUTH_TOKEN: "" })).toMatch(/^[0-9a-f]{64}$/);
  });
  it("fails with exit 2 and points at `mimir init` when there is no token", () => {
    const e = cliError(() => showToken(env));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain(join(data, "auth-token"));
    expect(e.message).toContain("mimir init");
  });
  it("fails with exit 2 instead of printing an empty token", () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "auth-token"), "  \n");
    const e = cliError(() => showToken(env));
    expect(e.exitCode).toBe(2);
    expect(e.message).toContain("is empty");
  });
  it("uses process.env by default", () => {
    vi.stubEnv("MIMIR_DATA_DIR", data);
    vi.stubEnv("MIMIR_AUTH_TOKEN", "process-env-token-0123");
    expect(showToken()).toBe("process-env-token-0123");
  });
});
