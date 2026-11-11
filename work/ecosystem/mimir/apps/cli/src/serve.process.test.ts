import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runServer, spawnServer, type ServerProcess } from "./serve.js";

// In-process counterparts of serve.test.ts: the real server as a child, on an ephemeral port.
let home: string;
let data: string;
let env: NodeJS.ProcessEnv;
const started: ServerProcess[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-serve-ip-"));
  data = join(home, "data");
  const web = join(home, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>mimir-test-app</title>");
  env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    MIMIR_DATA_DIR: data,
    MIMIR_PORT: "0",
    MIMIR_WEB_ROOT: web,
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of started.splice(0)) {
    s.child.kill("SIGKILL");
    await s.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 45_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("spawnServer (real server)", () => {
  it("starts on the configured port, serves the web app and the API, and stops on stop()", async () => {
    const lines: string[] = [];
    const s = spawnServer(env, { runtime: "none" }, (line) => lines.push(line));
    started.push(s);
    const url = await s.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(`${url}/`)).text()).toContain("mimir-test-app");
    expect((await fetch(`${url}/v1/missions`)).status).toBe(401);
    const token = readFileSync(join(data, "auth-token"), "utf8").trim();
    const authed = await fetch(`${url}/v1/missions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authed.status).toBe(200);
    await waitFor("the runtime line", () => lines.find((l) => l.startsWith("runtime: none")));
    s.stop();
    expect(await s.exited).toBe(0);
  });

  it("rejects the URL and reports the server's message when it cannot start", async () => {
    const lines: [string, string][] = [];
    const s = spawnServer({ ...env, MIMIR_PORT: "not-a-port" }, {}, (line, stream) =>
      lines.push([line, stream]),
    );
    started.push(s);
    await expect(s.url).rejects.toThrow(/server exited with code [1-9]/);
    expect(await s.exited).not.toBe(0);
    await waitFor("the error line", () =>
      lines.find(([l, stream]) => stream === "stderr" && l.includes("Invalid MIMIR_PORT")),
    );
  });
});

describe("runServer (real server)", () => {
  it("runs until SIGINT, shuts the server down cleanly and returns 0", async () => {
    let out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const before = process.listeners("SIGINT");
    const done = runServer(env, { runtime: "none" });
    const sigint = process.listeners("SIGINT").filter((l) => !before.includes(l));
    expect(sigint).toHaveLength(1);
    const url = await waitFor("the URL", () => /listening on (http:\/\/\S+)/.exec(out)?.[1]);
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
    (sigint[0] as () => void)();
    expect(await done).toBe(0);
    expect(process.listeners("SIGINT")).toEqual(before);
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it("returns 3 and forwards the reason to stderr when the server cannot start", async () => {
    let err = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err += String(chunk);
      return true;
    });
    expect(await runServer({ ...env, MIMIR_PORT: "70000" }, {})).toBe(3);
    await waitFor("the error line", () =>
      err.includes("Invalid MIMIR_PORT: 70000") ? 1 : undefined,
    );
  });
});
