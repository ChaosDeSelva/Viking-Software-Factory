import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAuthToken, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults to loopback 127.0.0.1:7800, ~/.sindri and the web dev origin", () => {
    const c = loadConfig({ HOME: homedir() + "-no-such-home-for-test" });
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(7800);
    expect(c.dataDir).toBe(join(homedir() + "-no-such-home-for-test", ".sindri"));
    expect(c.allowedOrigins).toEqual(["http://127.0.0.1:5173", "http://localhost:5173"]);
    expect(c.tls).toBeUndefined();
  });

  it("reads SINDRI_PORT, SINDRI_DATA_DIR and SINDRI_ALLOWED_ORIGINS", () => {
    const c = loadConfig({
      SINDRI_PORT: "7900",
      SINDRI_DATA_DIR: "/tmp/x",
      SINDRI_ALLOWED_ORIGINS: "http://localhost:3000, http://127.0.0.1:4173",
    });
    expect(c.port).toBe(7900);
    expect(c.dataDir).toBe("/tmp/x");
    expect(c.allowedOrigins).toEqual(["http://localhost:3000", "http://127.0.0.1:4173"]);
  });

  it("rejects an invalid port", () => {
    expect(() => loadConfig({ SINDRI_PORT: "99999" })).toThrow(/SINDRI_PORT/);
    expect(() => loadConfig({ SINDRI_PORT: "abc" })).toThrow(/SINDRI_PORT/);
  });

  it("accepts other loopback hosts", () => {
    expect(loadConfig({ SINDRI_HOST: "localhost" }).host).toBe("localhost");
    expect(loadConfig({ SINDRI_HOST: "::1" }).host).toBe("::1");
  });

  it("refuses a non-loopback host without SINDRI_ALLOW_REMOTE=1 and TLS", () => {
    expect(() => loadConfig({ SINDRI_HOST: "0.0.0.0" })).toThrow(/SINDRI_ALLOW_REMOTE/);
    expect(() => loadConfig({ SINDRI_HOST: "0.0.0.0", SINDRI_ALLOW_REMOTE: "1" })).toThrow(/TLS/);
    const c = loadConfig({
      SINDRI_HOST: "0.0.0.0",
      SINDRI_ALLOW_REMOTE: "1",
      SINDRI_TLS_CERT: "/c.pem",
      SINDRI_TLS_KEY: "/k.pem",
    });
    expect(c.host).toBe("0.0.0.0");
    expect(c.tls).toEqual({ certPath: "/c.pem", keyPath: "/k.pem" });
  });
});

describe("loadConfig with <dataDir>/config.json (review S8a I1)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dataWith = (cfg: unknown): string => {
    const d = mkdtempSync(join(tmpdir(), "sindri-cfg-"));
    dirs.push(d);
    writeFileSync(join(d, "config.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
    return d;
  };

  it("reads host, port and allowedOrigins from config.json", () => {
    const d = dataWith({
      host: "localhost",
      port: 7811,
      allowedOrigins: ["http://localhost:4000"],
    });
    const c = loadConfig({ SINDRI_DATA_DIR: d });
    expect(c.host).toBe("localhost");
    expect(c.port).toBe(7811);
    expect(c.allowedOrigins).toEqual(["http://localhost:4000"]);
    expect(c.dataDir).toBe(d);
  });

  it("lets the environment override config.json", () => {
    const d = dataWith({ host: "localhost", port: 7811 });
    const c = loadConfig({ SINDRI_DATA_DIR: d, SINDRI_PORT: "7822", SINDRI_HOST: "127.0.0.1" });
    expect(c.port).toBe(7822);
    expect(c.host).toBe("127.0.0.1");
  });

  it("finds config.json under $HOME/.sindri when SINDRI_DATA_DIR is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "sindri-home-"));
    dirs.push(home);
    mkdirSync(join(home, ".sindri"));
    writeFileSync(join(home, ".sindri", "config.json"), JSON.stringify({ port: 7833 }));
    const c = loadConfig({ HOME: home });
    expect(c.dataDir).toBe(join(home, ".sindri"));
    expect(c.port).toBe(7833);
  });

  it("refuses an unreadable or invalid config.json with the file name", () => {
    expect(() => loadConfig({ SINDRI_DATA_DIR: dataWith("{nope") })).toThrow(/config\.json/);
    expect(() => loadConfig({ SINDRI_DATA_DIR: dataWith({ port: "x" }) })).toThrow(/port/);
    expect(() => loadConfig({ SINDRI_DATA_DIR: dataWith({ port: 70000 }) })).toThrow(/port/);
  });

  it("applies the non-loopback rules to a host from config.json", () => {
    expect(() => loadConfig({ SINDRI_DATA_DIR: dataWith({ host: "0.0.0.0" }) })).toThrow(
      /SINDRI_ALLOW_REMOTE/,
    );
  });
});

describe("ensureAuthToken", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "sindri-token-"));
    dirs.push(d);
    return d;
  };

  it("generates a 0600 token file under the data dir and reuses it", () => {
    const dir = join(tmp(), "data");
    const a = ensureAuthToken(dir);
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.path).toBe(join(dir, "auth-token"));
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(ensureAuthToken(dir).token).toBe(a.token);
  });

  it("tightens a token file with loose permissions", () => {
    const dir = tmp();
    writeFileSync(join(dir, "auth-token"), "abc123abc123abc123abc123abc123ab\n");
    chmodSync(join(dir, "auth-token"), 0o644);
    const a = ensureAuthToken(dir);
    expect(a.token).toBe("abc123abc123abc123abc123abc123ab");
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
  });

  it("replaces an empty or too-short token", () => {
    const dir = tmp();
    writeFileSync(join(dir, "auth-token"), "short");
    const a = ensureAuthToken(dir);
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(a.path, "utf8").trim()).toBe(a.token);
  });
});
