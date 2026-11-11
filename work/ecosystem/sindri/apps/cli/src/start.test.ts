import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError, EXIT_CONFIG, EXIT_INFRA } from "./env.js";
import { defaultWebDist, start, webDistDir } from "./start.js";

let home: string;
let web: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-start-"));
  web = join(home, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<html><title>start fixture</title></html>");
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

/** An ephemeral loopback port: listen on 0, read it back, release it. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
const envFor = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  HOME: home,
  SINDRI_DATA_DIR: join(home, "data"),
  SINDRI_SECRET_STORE: "env",
  SINDRI_WEB_DIST: web,
  ...extra,
});
const rejection = async (p: Promise<unknown>): Promise<CliError> => {
  const e = await p.then(
    () => new Error("expected a rejection"),
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CliError);
  return e as CliError;
};

describe("webDistDir", () => {
  it("prefers SINDRI_WEB_DIST, else the web build beside this package", () => {
    expect(webDistDir({ SINDRI_WEB_DIST: "/w" })).toBe("/w");
    expect(webDistDir({ SINDRI_WEB_DIST: "" })).toBe(
      fileURLToPath(new URL("../../web/dist", import.meta.url)),
    );
  });
  it("decodes the install path, so a directory with a space still resolves", () => {
    expect(defaultWebDist("file:///opt/my%20apps/sindri/apps/cli/dist/start.js")).toBe(
      "/opt/my apps/sindri/apps/web/dist",
    );
  });
});

describe("start", () => {
  it("serves on one origin, prints the pairing code to stderr only, and closes", async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });
    const port = await freePort();
    const s = await start(envFor({ SINDRI_PORT: String(port) }));
    try {
      expect(s.url).toBe(`http://127.0.0.1:${port}`);
      expect(await (await fetch(`${s.url}/v1/health`)).json()).toEqual({ status: "ok" });
      expect(await (await fetch(`${s.url}/`)).text()).toContain("start fixture");
      expect(stderr.join("")).toMatch(/sindri approval pairing code: \S+\n/);
      expect(stderr.join("")).toContain("Never give it to an agent");
    } finally {
      await s.close();
    }
    await expect(fetch(`${s.url}/v1/health`)).rejects.toThrow();
  });

  it("honours SINDRI_LOG_LEVEL", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const port = await freePort();
    const s = await start(envFor({ SINDRI_PORT: String(port), SINDRI_LOG_LEVEL: "error" }));
    await s.close();
    expect(s.url).toBe(`http://127.0.0.1:${port}`);
  });

  it("exits 2 without a web build or with a bad config", async () => {
    const noWeb = await rejection(start(envFor({ SINDRI_WEB_DIST: join(home, "nope") })));
    expect(noWeb.exitCode).toBe(EXIT_CONFIG);
    expect(noWeb.message).toContain(`web build not found at ${join(home, "nope")}`);
    const badPort = await rejection(start(envFor({ SINDRI_PORT: "seventy" })));
    expect(badPort.exitCode).toBe(EXIT_CONFIG);
    expect(badPort.message).toBe("Invalid SINDRI_PORT: seventy");
  });

  it("exits 3 when the server cannot start (port taken)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const taken: Server = createServer();
    await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
    try {
      const port = (taken.address() as { port: number }).port;
      const e = await rejection(start(envFor({ SINDRI_PORT: String(port) })));
      expect(e.exitCode).toBe(EXIT_INFRA);
      expect(e.message).toMatch(/^cannot start: .*EADDRINUSE/);
    } finally {
      await new Promise((r) => taken.close(r));
    }
  });
});
