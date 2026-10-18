import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOWED_ORIGINS,
  ensureAuthToken,
  isLoopbackHost,
  loadConfig,
  resolveListenOptions,
} from "./config.js";

describe("resolveListenOptions", () => {
  it("defaults to loopback port 7700", () => {
    expect(resolveListenOptions({})).toEqual({ host: "127.0.0.1", port: 7700, tls: null });
  });
  it("honours MIMIR_PORT and a loopback MIMIR_HOST", () => {
    expect(resolveListenOptions({ MIMIR_PORT: "7801", MIMIR_HOST: "::1" })).toEqual({
      host: "::1",
      port: 7801,
      tls: null,
    });
  });
  it("rejects an invalid MIMIR_PORT", () => {
    expect(() => resolveListenOptions({ MIMIR_PORT: "abc" })).toThrow(/MIMIR_PORT/);
  });
  it("refuses a non-loopback bind without MIMIR_ALLOW_REMOTE=1 and TLS", () => {
    expect(() => resolveListenOptions({ MIMIR_HOST: "0.0.0.0" })).toThrow(/non-loopback/);
    expect(() => resolveListenOptions({ MIMIR_HOST: "0.0.0.0", MIMIR_ALLOW_REMOTE: "1" })).toThrow(
      /MIMIR_TLS_CERT/,
    );
    expect(() =>
      resolveListenOptions({
        MIMIR_HOST: "192.168.1.5",
        MIMIR_TLS_CERT: "/c.pem",
        MIMIR_TLS_KEY: "/k.pem",
      }),
    ).toThrow(/MIMIR_ALLOW_REMOTE/);
  });
  it("allows a non-loopback bind with MIMIR_ALLOW_REMOTE=1 and both TLS paths", () => {
    expect(
      resolveListenOptions({
        MIMIR_HOST: "0.0.0.0",
        MIMIR_ALLOW_REMOTE: "1",
        MIMIR_TLS_CERT: "/c.pem",
        MIMIR_TLS_KEY: "/k.pem",
      }),
    ).toEqual({ host: "0.0.0.0", port: 7700, tls: { certPath: "/c.pem", keyPath: "/k.pem" } });
  });
});

describe("isLoopbackHost", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["::1", true],
    ["localhost", true],
    ["0.0.0.0", false],
    ["::", false],
    ["10.0.0.1", false],
    ["example.com", false],
  ])("%s -> %s", (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });
});

describe("loadConfig", () => {
  it("derives data paths from MIMIR_DATA_DIR, defaulting to ~/.mimir", () => {
    const c = loadConfig({}, "/home/u");
    expect(c.dataDir).toBe("/home/u/.mimir");
    expect(c.dbPath).toBe("/home/u/.mimir/mimir.db");
    expect(c.authTokenPath).toBe("/home/u/.mimir/auth-token");
    expect(loadConfig({ MIMIR_DATA_DIR: "/data" }, "/home/u").dbPath).toBe("/data/mimir.db");
  });
  it("puts agent worktrees outside the data dir by default (audit H1)", () => {
    expect(loadConfig({}, "/home/u").worktreeRoot).toBe("/home/u/.mimir-work/worktrees");
    expect(loadConfig({ MIMIR_WORKTREE_ROOT: "/srv/wt" }, "/home/u").worktreeRoot).toBe("/srv/wt");
  });
  it("refuses a worktree root inside (or equal to) the data dir", () => {
    for (const env of [
      { MIMIR_WORKTREE_ROOT: "/home/u/.mimir/worktrees" },
      { MIMIR_WORKTREE_ROOT: "/home/u/.mimir" },
      { MIMIR_DATA_DIR: "/d", MIMIR_WORKTREE_ROOT: "/d/wt" },
      { MIMIR_DATA_DIR: "/d", MIMIR_WORKTREE_ROOT: "/d/x/../wt" },
    ]) {
      expect(() => loadConfig(env, "/home/u"), JSON.stringify(env)).toThrow(/data dir/);
    }
    expect(
      loadConfig({ MIMIR_DATA_DIR: "/d", MIMIR_WORKTREE_ROOT: "/dw" }, "/h").worktreeRoot,
    ).toBe("/dw");
  });
  it("resolves relative data and worktree dirs before comparing them", () => {
    expect(loadConfig({ MIMIR_DATA_DIR: "rel" }, "/h").dataDir).toBe(join(process.cwd(), "rel"));
    expect(() =>
      loadConfig({ MIMIR_DATA_DIR: "rel", MIMIR_WORKTREE_ROOT: "rel/wt" }, "/h"),
    ).toThrow(/data dir/);
  });
  it("parses allowed origins and roots, defaulting origins to the web dev server", () => {
    const c = loadConfig({}, "/h");
    expect(c.allowedOrigins).toEqual(DEFAULT_ALLOWED_ORIGINS);
    expect(DEFAULT_ALLOWED_ORIGINS).toContain("http://127.0.0.1:5173");
    expect(c.allowedRoots).toEqual([]);
    const d = loadConfig(
      { MIMIR_ALLOWED_ORIGINS: "https://a.test, https://b.test", MIMIR_ALLOWED_ROOTS: "/r1:/r2" },
      "/h",
    );
    expect(d.allowedOrigins).toEqual(["https://a.test", "https://b.test"]);
    expect(d.allowedRoots).toEqual(["/r1", "/r2"]);
  });
  it("derives public origins from the listen address unless MIMIR_PUBLIC_ORIGINS is set", () => {
    expect(loadConfig({}, "/h").publicOrigins).toEqual([
      "http://127.0.0.1:7700",
      "http://localhost:7700",
      "http://[::1]:7700",
    ]);
    const tls = { MIMIR_ALLOW_REMOTE: "1", MIMIR_TLS_CERT: "/c", MIMIR_TLS_KEY: "/k" };
    expect(loadConfig({ ...tls, MIMIR_HOST: "10.0.0.5" }, "/h").publicOrigins).toEqual([
      "https://10.0.0.5:7700",
    ]);
    expect(() => loadConfig({ ...tls, MIMIR_HOST: "0.0.0.0" }, "/h")).toThrow(
      /MIMIR_PUBLIC_ORIGINS/,
    );
    expect(
      loadConfig({ ...tls, MIMIR_HOST: "0.0.0.0", MIMIR_PUBLIC_ORIGINS: "https://m.test" }, "/h")
        .publicOrigins,
    ).toEqual(["https://m.test"]);
  });

  it("rejects a MIMIR_AUTH_TOKEN shorter than 32 characters", () => {
    expect(() => loadConfig({ MIMIR_AUTH_TOKEN: "short" }, "/h")).toThrow(/MIMIR_AUTH_TOKEN/);
  });

  it("selects the runtime from MIMIR_RUNTIME (fake by default)", () => {
    expect(loadConfig({}, "/h").runtime).toBe("fake");
    expect(loadConfig({ MIMIR_RUNTIME: "none" }, "/h").runtime).toBe("none");
    expect(loadConfig({ MIMIR_RUNTIME: "herdr" }, "/h").runtime).toBe("herdr");
    expect(() => loadConfig({ MIMIR_RUNTIME: "bogus" }, "/h")).toThrow(/MIMIR_RUNTIME/);
  });
  it("reads MIMIR_WEB_ROOT (null by default)", () => {
    expect(loadConfig({}, "/h").webRoot).toBeNull();
    expect(loadConfig({ MIMIR_WEB_ROOT: "/srv/web" }, "/h").webRoot).toBe("/srv/web");
  });
  it("reads orchestration settings: tick, artifact retention, approval ttl", () => {
    const d = loadConfig({}, "/h");
    expect(d).toMatchObject({
      tickMs: 1000,
      artifactRetentionDays: 30,
      approvalTtlMs: null,
      maxArtifactBytes: 64 * 1024 * 1024,
    });
    expect(loadConfig({ MIMIR_MAX_ARTIFACT_BYTES: "1024" }, "/h").maxArtifactBytes).toBe(1024);
    const c = loadConfig(
      {
        MIMIR_TICK_MS: "250",
        MIMIR_ARTIFACT_RETENTION_DAYS: "7",
        MIMIR_APPROVAL_TTL_MS: "60000",
      },
      "/h",
    );
    expect(c).toMatchObject({ tickMs: 250, artifactRetentionDays: 7, approvalTtlMs: 60000 });
    expect(() => loadConfig({ MIMIR_TICK_MS: "-1" }, "/h")).toThrow(/MIMIR_TICK_MS/);
    expect(() => loadConfig({ MIMIR_ARTIFACT_RETENTION_DAYS: "0" }, "/h")).toThrow(
      /MIMIR_ARTIFACT_RETENTION_DAYS/,
    );
    expect(() => loadConfig({ MIMIR_APPROVAL_TTL_MS: "soon" }, "/h")).toThrow(
      /MIMIR_APPROVAL_TTL_MS/,
    );
  });
});

const ENV_TOKEN = "e".repeat(32);

describe("ensureAuthToken", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mimir-cfg-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses MIMIR_AUTH_TOKEN when set and writes nothing", () => {
    const c = loadConfig({ MIMIR_DATA_DIR: dir, MIMIR_AUTH_TOKEN: ENV_TOKEN }, "/h");
    expect(ensureAuthToken(c)).toEqual({ token: ENV_TOKEN, source: "env", path: null });
  });
  it("generates a token on first start into <data>/auth-token with mode 0600, then reuses it", () => {
    const c = loadConfig({ MIMIR_DATA_DIR: join(dir, "nested") }, "/h");
    const first = ensureAuthToken(c);
    expect(first.source).toBe("generated");
    expect(first.token.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(c.authTokenPath, "utf8").trim()).toBe(first.token);
    expect(statSync(c.authTokenPath).mode & 0o777).toBe(0o600);
    const second = ensureAuthToken(c);
    expect(second).toEqual({ token: first.token, source: "file", path: c.authTokenPath });
  });
  it("tightens permissions on an existing token file and data dir", () => {
    const c = loadConfig({ MIMIR_DATA_DIR: dir }, "/h");
    chmodSync(dir, 0o755);
    const existing = "existing-token-".padEnd(40, "x");
    writeFileSync(c.authTokenPath, `${existing}\n`, { mode: 0o644 });
    expect(ensureAuthToken(c).token).toBe(existing);
    expect(statSync(c.authTokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
  it("refuses a token file shorter than the minimum token length (audit L3)", () => {
    const c = loadConfig({ MIMIR_DATA_DIR: dir }, "/h");
    writeFileSync(c.authTokenPath, "short\n", { mode: 0o600 });
    expect(() => ensureAuthToken(c)).toThrow(/at least 32 characters/);
  });
  it("refuses a token file that is a symlink (it could point anywhere)", () => {
    const c = loadConfig({ MIMIR_DATA_DIR: dir }, "/h");
    const target = join(dir, "elsewhere");
    writeFileSync(target, `${"t".repeat(40)}\n`, { mode: 0o644 });
    symlinkSync(target, c.authTokenPath);
    expect(() => ensureAuthToken(c)).toThrow(/regular file/);
    expect(statSync(target).mode & 0o777).toBe(0o644); // never chmod-ed through the link
  });
  it("refuses a data dir that is not a directory", () => {
    const file = join(dir, "file");
    writeFileSync(file, "x");
    expect(() => ensureAuthToken(loadConfig({ MIMIR_DATA_DIR: file }, "/h"))).toThrow(
      /not a directory/,
    );
  });
  it("creates a missing data dir 0700 even under a permissive umask", () => {
    const old = process.umask(0);
    try {
      const nested = join(dir, "a", "b");
      mkdirSync(join(dir, "a"));
      ensureAuthToken(loadConfig({ MIMIR_DATA_DIR: nested }, "/h"));
      expect(statSync(nested).mode & 0o777).toBe(0o700);
      expect(statSync(join(nested, "auth-token")).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(old);
    }
  });
});
