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
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { execa } from "execa";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = new URL("../dist/main.js", import.meta.url).pathname;
let home: string;
let data: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-cli-"));
  data = join(home, "data");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const envFor = (extra: Record<string, string> = {}) => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  SINDRI_DATA_DIR: data,
  SINDRI_SECRET_STORE: "env",
  ...extra,
});
const run = (args: string[], extra: Record<string, string> = {}) =>
  execa(process.execPath, [MAIN, ...args], { reject: false, extendEnv: false, env: envFor(extra) });

interface Check {
  name: string;
  status: string;
  detail: string;
}
const check = (stdout: string, name: string): Check =>
  (JSON.parse(stdout).checks as Check[]).find((c) => c.name === name) as Check;

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(data, { recursive: true });
  const db = openDatabase(join(data, "sindri.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS server_settings (id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  db.prepare("INSERT OR REPLACE INTO server_settings VALUES (1, ?, ?)").run(
    JSON.stringify(settings),
    new Date().toISOString(),
  );
  db.close();
}

describe("sindri init / token show", () => {
  it("creates the data dir, config.json and a 0600 token, idempotently", async () => {
    const a = await run(["init", "--json"]);
    expect(a.exitCode).toBe(0);
    const out = JSON.parse(a.stdout);
    expect(out.dataDir).toBe(data);
    expect(out.tokenCreated).toBe(true);
    const tokenPath = join(data, "auth-token");
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenPath, "utf8");
    expect(token.trim().length).toBeGreaterThanOrEqual(32);
    expect(JSON.parse(readFileSync(join(data, "config.json"), "utf8")).port).toBe(7800);
    const b = JSON.parse((await run(["init", "--json"])).stdout);
    expect(b.tokenCreated).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe(token);
  });
  it("never overwrites config.json, tightens the data dir and replaces a short token (review m4)", async () => {
    mkdirSync(data, { recursive: true, mode: 0o755 });
    chmodSync(data, 0o755);
    writeFileSync(join(data, "config.json"), '{"port": 7999}\n');
    writeFileSync(join(data, "auth-token"), "short\n");
    const r = await run(["init", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(data, "config.json"), "utf8")).toBe('{"port": 7999}\n');
    expect(statSync(data).mode & 0o777).toBe(0o700);
    expect(JSON.parse(r.stdout).tokenCreated).toBe(true);
    expect(readFileSync(join(data, "auth-token"), "utf8").trim().length).toBe(64);
  });
  it("writes only keys that sindri start reads to config.json (review I1)", async () => {
    await run(["init"]);
    const cfg = JSON.parse(readFileSync(join(data, "config.json"), "utf8"));
    expect(Object.keys(cfg).sort()).toEqual(["host", "port"]);
  });
  it("never prints the token outside token show", async () => {
    const i = await run(["init", "--json"]);
    const token = readFileSync(join(data, "auth-token"), "utf8").trim();
    const d = await run(["doctor", "--json"]);
    expect(i.stdout + i.stderr + d.stdout + d.stderr).not.toContain(token);
  });
  it("defaults the data dir to ~/.sindri", async () => {
    const r = await execa(process.execPath, [MAIN, "init", "--json"], {
      reject: false,
      extendEnv: false,
      env: { PATH: process.env["PATH"] ?? "", HOME: home },
    });
    expect(JSON.parse(r.stdout).dataDir).toBe(join(home, ".sindri"));
  });
  it("token show prints the token, and exits 2 before init", async () => {
    const none = await run(["token", "show"]);
    expect(none.exitCode).toBe(2);
    expect(none.stderr).toContain("sindri init");
    const noneJson = await run(["token", "show", "--json"]);
    expect(noneJson.exitCode).toBe(2);
    expect(JSON.parse(noneJson.stdout)).toMatchObject({ ok: false, exitCode: 2 });
    expect(JSON.parse(noneJson.stdout).error).toContain("sindri init");
    await run(["init"]);
    const shown = await run(["token", "show", "--json"]);
    expect(shown.exitCode).toBe(0);
    expect(JSON.parse(shown.stdout).token).toBe(
      readFileSync(join(data, "auth-token"), "utf8").trim(),
    );
  });
});

describe("sindri doctor", () => {
  it("checks node and git, and reports Mimir as not configured without a URL", async () => {
    const r = await run(["doctor", "--json"]);
    const out = JSON.parse(r.stdout);
    expect(check(r.stdout, "node").status).toBe("ok");
    expect(check(r.stdout, "git").status).toBe("ok");
    expect(check(r.stdout, "mimir").detail).toContain("not configured");
    expect(check(r.stdout, "mimir").status).toBe("warn");
    expect(r.exitCode).toBe(out.ok ? 0 : 3);
    expect(out.ok).toBe(true);
  });
  it("reports the provider key present or absent and never prints the value", async () => {
    writeSettings({
      provider: "anthropic",
      model: "m",
      localOnly: true,
      apiKeySecret: "anthropic.api-key",
    });
    const absent = await run(["doctor", "--json"]);
    expect(check(absent.stdout, "provider-key").status).toBe("warn");
    expect(check(absent.stdout, "provider-key").detail).toContain("absent");
    const secret = "sk-ant-super-secret-value";
    const present = await run(["doctor", "--json"], { SINDRI_SECRET_ANTHROPIC_API_KEY: secret });
    expect(check(present.stdout, "provider-key").status).toBe("ok");
    expect(check(present.stdout, "provider-key").detail).toContain("present");
    expect(present.stdout + present.stderr).not.toContain(secret);
  });
  it("fails the config check on an invalid config.json and exits 3", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), '{"port": "nope"}');
    const r = await run(["doctor", "--json"]);
    expect(check(r.stdout, "config").status).toBe("fail");
    expect(check(r.stdout, "config").detail).toContain("port");
    expect(r.exitCode).toBe(3);
  });
  it("reports config.json as ok when absent or valid", async () => {
    const r = await run(["doctor", "--json"]);
    expect(check(r.stdout, "config").status).toBe("ok");
  });
  it("needs no key for the local fake provider (review m7)", async () => {
    writeSettings({ provider: "fake", model: "m", localOnly: true });
    const r = await run(["doctor", "--json"]);
    expect(check(r.stdout, "provider-key").status).toBe("ok");
    expect(check(r.stdout, "provider-key").detail).toContain("no key");
  });
  describe("mimir", () => {
    let srv: Server;
    let url: string;
    const serve = async (status: number, body: unknown) => {
      srv = createServer((_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    };
    afterEach(() => new Promise((r) => (srv ? srv.close(() => r(undefined)) : r(undefined))));

    it("is ok when protocolVersion is 1", async () => {
      await serve(200, { serverVersion: "0.1.0", protocolVersion: 1, runtime: null });
      writeSettings({ provider: "null", model: "m", localOnly: true, mimirUrl: url });
      const r = await run(["doctor", "--json"]);
      expect(check(r.stdout, "mimir").status).toBe("ok");
      expect(check(r.stdout, "mimir").detail).toContain("protocol 1");
    });
    it("fails on an incompatible protocol and exits 3", async () => {
      await serve(200, { serverVersion: "9.0.0", protocolVersion: 2, runtime: null });
      writeSettings({ provider: "null", model: "m", localOnly: true, mimirUrl: url });
      const r = await run(["doctor", "--json"]);
      expect(check(r.stdout, "mimir").status).toBe("fail");
      expect(check(r.stdout, "mimir").detail).toContain("incompatible");
      expect(r.exitCode).toBe(3);
    });
    it("warns when unreachable (SINDRI_MIMIR_URL overrides settings)", async () => {
      const r = await run(["doctor", "--json"], { SINDRI_MIMIR_URL: "http://127.0.0.1:1" });
      expect(check(r.stdout, "mimir").status).toBe("warn");
      expect(check(r.stdout, "mimir").detail).toContain("unreachable");
    });
    it("never echoes credentials embedded in the Mimir URL (review m6)", async () => {
      const r = await run(["doctor", "--json"], {
        SINDRI_MIMIR_URL: "http://alice:hunter2pass@127.0.0.1:1/",
      });
      expect(check(r.stdout, "mimir").detail).toContain("127.0.0.1:1");
      expect(r.stdout).not.toContain("hunter2pass");
      expect(r.stdout).not.toContain("alice");
    });
  });
});

describe("sindri start", () => {
  it("serves the API and the built web app on one origin", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = netServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const web = join(home, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<html><title>Sindri fixture</title></html>");
    writeFileSync(join(web, "assets", "a.js"), "console.log(1)");
    writeFileSync(join(home, "secret.txt"), "TOP-SECRET");
    writeFileSync(join(web, ".env"), "TOP-SECRET");
    symlinkSync(join(home, "secret.txt"), join(web, "escape.txt"));
    const child = execa(process.execPath, [MAIN, "start"], {
      reject: false,
      extendEnv: false,
      env: envFor({ SINDRI_PORT: String(port), SINDRI_WEB_DIST: web }),
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      let ok = false;
      for (let i = 0; i < 100 && !ok; i++) {
        ok = await fetch(`${base}/v1/health`).then(
          (r) => r.ok,
          () => false,
        );
        if (!ok) await new Promise((r) => setTimeout(r, 100));
      }
      expect(ok).toBe(true);
      expect(await (await fetch(`${base}/v1/health`)).json()).toEqual({ status: "ok" });
      const index = await fetch(`${base}/`);
      expect(index.headers.get("content-type")).toContain("text/html");
      expect(await index.text()).toContain("Sindri fixture");
      const js = await fetch(`${base}/assets/a.js`);
      expect(js.headers.get("content-type")).toContain("javascript");
      expect(await (await fetch(`${base}/projects/x`)).text()).toContain("Sindri fixture");
      expect((await fetch(`${base}/assets/..%2f..%2fauth-token`)).status).not.toBe(200);
      for (const p of ["/escape.txt", "/assets/..%2f..%2fsecret.txt", "/.env"]) {
        const res = await fetch(`${base}${p}`);
        expect(await res.text()).not.toContain("TOP-SECRET");
      }
      expect(js.headers.get("x-content-type-options")).toBe("nosniff");
      const missingAsset = await fetch(`${base}/assets/nope.js`);
      expect(missingAsset.status).toBe(404);
      const api = await fetch(`${base}/v1/nope`);
      expect(api.status).toBe(401);
      const token = readFileSync(join(data, "auth-token"), "utf8").trim();
      const authed = await fetch(`${base}/v1/nope`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(authed.status).toBe(404);
      expect(((await authed.json()) as { error: { code: string } }).error.code).toBe("not_found");
    } finally {
      child.kill("SIGTERM");
      await child;
    }
  }, 30_000);
  it("reads the port from config.json, and the environment wins (review I1)", async () => {
    const free = () =>
      new Promise<number>((resolve) => {
        const s = netServer().listen(0, "127.0.0.1", () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
    const [filePort, envPort] = [await free(), await free()];
    const web = join(home, "web");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<html></html>");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ port: filePort }));
    for (const [extra, port] of [
      [{}, filePort],
      [{ SINDRI_PORT: String(envPort) }, envPort],
    ] as const) {
      const child = execa(process.execPath, [MAIN, "start", "--json"], {
        reject: false,
        extendEnv: false,
        env: envFor({ SINDRI_WEB_DIST: web, ...extra }),
      });
      try {
        let ok = false;
        for (let i = 0; i < 100 && !ok; i++) {
          ok = await fetch(`http://127.0.0.1:${port}/v1/health`).then(
            (r) => r.ok,
            () => false,
          );
          if (!ok) await new Promise((r) => setTimeout(r, 100));
        }
        expect(ok).toBe(true);
      } finally {
        child.kill("SIGTERM");
        await child;
      }
    }
  }, 30_000);
  it("exits 2 when the web build is missing", async () => {
    const r = await run(["start"], { SINDRI_WEB_DIST: join(home, "nope") });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("web");
  });
});

describe("sindri export", () => {
  it("exports a zip, refuses to overwrite, and exits 3 without a database", async () => {
    const out = join(home, "out", "x.zip");
    expect((await run(["export", "--out", out])).exitCode).toBe(3);
    writeSettings({ provider: "null", model: "m", localOnly: true });
    const r = await run(["export", "--out", out, "--json"]);
    expect(r.exitCode).toBe(0);
    const files = unzipSync(new Uint8Array(readFileSync(out)));
    expect(Object.keys(files).sort()).toEqual(["manifest.json", "settings.json", "sindri.db"]);
    expect((await run(["export", "--out", out])).exitCode).toBe(2);
    expect((await run(["export", "--out", out, "--force"])).exitCode).toBe(0);
  });
});

describe("sindri demo", () => {
  it("creates a sample repo, bootstraps it, imports the ticket and prints the URL", async () => {
    const dir = join(home, "demo");
    const r = await run(["demo", "--json", "--dir", dir, "--with-failing-test"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.repoPath).toBe(join(dir, "repo"));
    expect(out.failingTest).toBe("test/planted.test.js");
    expect(out.bootstrap.indexed).toBeGreaterThan(3);
    expect(out.url).toBe(`http://127.0.0.1:7800/#/inbox?project=${out.projectId}`);
    const db = openDatabase(join(data, "sindri.db"));
    try {
      const p = db.prepare("SELECT repo_path FROM projects WHERE id = ?").get(out.projectId) as {
        repo_path: string;
      };
      expect(p.repo_path).toBe(out.repoPath);
      const i = db.prepare("SELECT source, title FROM intakes WHERE id = ?").get(out.intakeId) as {
        source: string;
        title: string;
      };
      expect(i).toEqual({ source: "manual", title: "Add CSV export to the reports page" });
    } finally {
      db.close();
    }
  }, 60_000);
  it("prints the next steps as text and refuses a non-empty --dir with exit 2", async () => {
    const dir = join(home, "demo2");
    const r = await run(["demo", "--dir", dir]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("sindri start");
    expect(r.stdout).toContain("#/inbox?project=");
    expect((await run(["demo", "--dir", dir])).exitCode).toBe(2);
  }, 60_000);
  it("rejects unknown commands with exit 2", async () => {
    expect((await run(["bogus"])).exitCode).toBe(2);
  });
});

describe("sindri approve (audit M9)", () => {
  it("refuses to run without a terminal, so an agent cannot script an approval", async () => {
    await run(["init"]);
    const r = await run(["approve", "spec", "spc_1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/needs an interactive terminal/);
    expect(r.stdout).toBe("");
  });
});
