import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "@sindri/knowledge";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayUrl, doctor, parseVersion, type DoctorReport } from "./doctor.js";

let home: string;
let data: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sindri-doctor-"));
  data = join(home, "data");
});
afterEach(() => {
  chmodSync(home, 0o700);
  rmSync(home, { recursive: true, force: true });
});

const envFor = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  SINDRI_DATA_DIR: data,
  SINDRI_SECRET_STORE: "env",
  ...extra,
});
const check = (r: DoctorReport, name: string) => r.checks.find((c) => c.name === name)!;

function writeSettings(settings: Record<string, unknown> | string): void {
  mkdirSync(data, { recursive: true });
  const db = openDatabase(join(data, "sindri.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS server_settings (id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL, updated_at TEXT NOT NULL)",
  );
  db.prepare("INSERT OR REPLACE INTO server_settings VALUES (1, ?, ?)").run(
    typeof settings === "string" ? settings : JSON.stringify(settings),
    new Date().toISOString(),
  );
  db.close();
}

/** A directory holding a stub `git` that prints `out` (or nothing on PATH when `out` is null). */
function stubGitPath(out: string | null): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  if (out !== null) {
    writeFileSync(join(bin, "git"), `#!/bin/sh\necho '${out}'\n`);
    chmodSync(join(bin, "git"), 0o755);
  }
  return bin;
}

describe("parseVersion / displayUrl", () => {
  it("parses major.minor[.patch] out of surrounding text", () => {
    expect(parseVersion("git version 2.39.3 (Apple Git-145)")).toEqual([2, 39, 3]);
    expect(parseVersion("v25.1")).toEqual([25, 1, 0]);
    expect(parseVersion("no digits here")).toBeNull();
  });
  it("drops userinfo and the trailing slash, and hides an unparseable URL", () => {
    expect(displayUrl("http://alice:pw@127.0.0.1:9/")).toBe("http://127.0.0.1:9");
    expect(displayUrl("not a url")).toBe("(invalid URL)");
  });
});

describe("doctor", () => {
  it("passes on a fresh machine: node, git, writable data dir, absent config", async () => {
    const r = await doctor(envFor());
    expect(check(r, "node").detail).toContain(process.versions.node);
    expect(check(r, "git")).toMatchObject({ status: "ok" });
    expect(check(r, "git").detail).toMatch(/^\d+\.\d+\.\d+ \(>= 2\.38\.0\)$/);
    expect(check(r, "data-dir")).toMatchObject({ status: "ok", detail: `${data} writable` });
    expect(check(r, "config")).toMatchObject({
      status: "ok",
      detail: "config.json absent (defaults apply)",
    });
    expect(check(r, "provider-key")).toMatchObject({ status: "warn", required: false });
    expect(check(r, "provider-key").detail).toContain("not configured (provider null)");
    expect(r.ok).toBe(Number(process.versions.node.split(".")[0]) >= 25);
  });

  it("fails node below 25 or with an unparseable version", async () => {
    const real = Object.getOwnPropertyDescriptor(process, "versions")!;
    try {
      for (const [node, status] of [
        ["24.9.0", "fail"],
        ["garbage", "fail"],
        ["25.0.0", "ok"],
      ] as const) {
        Object.defineProperty(process, "versions", {
          ...real,
          value: { ...process.versions, node },
        });
        const r = await doctor(envFor());
        expect(check(r, "node")).toMatchObject({ status, detail: `${node} (>= 25)` });
        if (status === "fail") expect(r.ok).toBe(false);
        Object.defineProperty(process, "versions", real);
      }
    } finally {
      Object.defineProperty(process, "versions", real);
    }
  });

  it("fails git when it is missing, too old or unparseable", async () => {
    const missing = await doctor(envFor({ PATH: stubGitPath(null) }));
    expect(check(missing, "git")).toMatchObject({
      status: "fail",
      detail: "git not found on PATH",
    });
    expect(missing.ok).toBe(false);
    rmSync(join(home, "bin"), { recursive: true });
    const old = await doctor(envFor({ PATH: stubGitPath("git version 2.37.9") }));
    expect(check(old, "git")).toMatchObject({ status: "fail" });
    expect(check(old, "git").detail).toContain("older than 2.38.0");
    rmSync(join(home, "bin"), { recursive: true });
    const odd = await doctor(envFor({ PATH: stubGitPath("git version unknown") }));
    expect(check(odd, "git").status).toBe("fail");
    rmSync(join(home, "bin"), { recursive: true });
    const newer = await doctor(envFor({ PATH: stubGitPath("git version 3.0.0") }));
    expect(check(newer, "git")).toMatchObject({ status: "ok", detail: "3.0.0 (>= 2.38.0)" });
    rmSync(join(home, "bin"), { recursive: true });
    const exact = await doctor(envFor({ PATH: stubGitPath("git version 2.38") }));
    expect(check(exact, "git")).toMatchObject({ status: "ok", detail: "2.38.0 (>= 2.38.0)" });
  });

  it("reports the data dir not writable when its nearest existing parent is read-only", async () => {
    chmodSync(home, 0o500);
    const r = await doctor(envFor({ SINDRI_DATA_DIR: join(home, "a", "b") }));
    expect(check(r, "data-dir")).toMatchObject({
      status: "fail",
      detail: `${join(home, "a", "b")} not writable`,
    });
    expect(r.ok).toBe(false);
  });

  it("fails the data dir when it, or a parent of it, is a regular file", async () => {
    writeFileSync(join(home, "file"), "x");
    for (const dir of [join(home, "file"), join(home, "file", "sub")]) {
      const r = await doctor(envFor({ SINDRI_DATA_DIR: dir }));
      expect(check(r, "data-dir").status).toBe("fail");
      expect(r.ok).toBe(false);
    }
  });

  it("lists the keys of a valid config.json and fails an invalid one", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 7801 }));
    expect(check(await doctor(envFor()), "config")).toMatchObject({
      status: "ok",
      detail: "config.json valid (host, port)",
    });
    writeFileSync(join(data, "config.json"), "{}");
    expect(check(await doctor(envFor()), "config").detail).toContain("absent");
    writeFileSync(join(data, "config.json"), "{nope");
    const bad = await doctor(envFor());
    expect(check(bad, "config").status).toBe("fail");
    expect(check(bad, "config").detail).toContain("Invalid");
    expect(bad.ok).toBe(false);
  });

  describe("provider-key", () => {
    it("needs no key for a local CLI provider", async () => {
      writeSettings({ provider: "claude-cli" });
      expect(check(await doctor(envFor()), "provider-key")).toMatchObject({
        status: "ok",
        detail: "provider claude-cli needs no key",
      });
    });
    it("warns when a keyed provider has no key handle", async () => {
      writeSettings({ provider: "anthropic" });
      expect(check(await doctor(envFor()), "provider-key").detail).toContain(
        "not configured (provider anthropic)",
      );
    });
    it("reports presence only, never the value", async () => {
      writeSettings({ provider: "anthropic", apiKeySecret: "anthropic.api-key" });
      const secret = "sk-ant-in-process-secret";
      const r = await doctor(envFor({ SINDRI_SECRET_ANTHROPIC_API_KEY: secret }));
      expect(check(r, "provider-key")).toMatchObject({
        status: "ok",
        detail: 'key "anthropic.api-key" present in the secret store',
      });
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(check(await doctor(envFor()), "provider-key")).toMatchObject({
        status: "warn",
        detail: 'key "anthropic.api-key" absent from the secret store',
      });
    });
    it("treats a failing secret store as an absent key", async () => {
      writeSettings({ provider: "anthropic", apiKeySecret: "k" });
      const env = envFor();
      Object.defineProperty(env, "SINDRI_SECRET_K", {
        enumerable: false,
        get() {
          throw new Error("store exploded");
        },
      });
      const r = await doctor(env);
      expect(check(r, "provider-key").detail).toContain("absent");
      expect(JSON.stringify(r)).not.toContain("exploded");
    });
    it("falls back to defaults on a corrupt database, settings row or settings JSON", async () => {
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "sindri.db"), "this is not sqlite");
      expect(check(await doctor(envFor()), "provider-key").detail).toContain("provider null");
      rmSync(join(data, "sindri.db"));
      openDatabase(join(data, "sindri.db")).close(); // no server_settings table
      expect(check(await doctor(envFor()), "provider-key").detail).toContain("provider null");
      writeSettings("{not json");
      expect(check(await doctor(envFor()), "provider-key").detail).toContain("provider null");
      const db = openDatabase(join(data, "sindri.db"));
      db.exec("DELETE FROM server_settings");
      db.close();
      expect(check(await doctor(envFor()), "provider-key").detail).toContain("provider null");
    });
  });

  describe("mimir", () => {
    let srv: Server | undefined;
    let seen: { url: string; headers: IncomingHttpHeaders }[];
    const serve = async (status: number, body: string, onlyPath?: string): Promise<string> => {
      seen = [];
      srv = createServer((req, res) => {
        seen.push({ url: req.url ?? "", headers: req.headers });
        const hit = onlyPath === undefined || req.url === onlyPath;
        res.writeHead(hit ? status : 404, { "content-type": "application/json" });
        res.end(hit ? body : "{}");
      });
      await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
      return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    };
    afterEach(async () => {
      if (srv) await new Promise((r) => srv!.close(r));
      srv = undefined;
    });
    const caps = (o: Record<string, unknown>) => JSON.stringify(o);

    it("is ok with protocol 1, sends MIMIR_AUTH_TOKEN as a bearer header, and names the server", async () => {
      const url = await serve(200, caps({ protocolVersion: 1, serverVersion: "0.2.0" }));
      const r = await doctor(envFor({ SINDRI_MIMIR_URL: url, MIMIR_AUTH_TOKEN: "mtok" }));
      expect(check(r, "mimir")).toMatchObject({
        status: "ok",
        detail: `${url} protocol 1, server 0.2.0`,
      });
      expect(seen[0]).toMatchObject({ url: "/v1/capabilities" });
      expect(seen[0]!.headers.authorization).toBe("Bearer mtok");
      expect(JSON.stringify(r)).not.toContain("mtok");
    });
    it("reports an unknown server version and sends no auth header without a token", async () => {
      const url = await serve(200, caps({ protocolVersion: 1 }));
      writeSettings({ mimirUrl: url, localOnly: false });
      const r = await doctor(envFor());
      expect(check(r, "mimir").detail).toContain("server unknown");
      expect(seen[0]!.headers.authorization).toBeUndefined();
    });
    it("probes capabilities under a Mimir URL with a path prefix, as the client does", async () => {
      const url = await serve(200, caps({ protocolVersion: 1 }), "/mimir/v1/capabilities");
      const r = await doctor(envFor({ SINDRI_MIMIR_URL: `${url}/mimir/` }));
      expect(seen.map((s) => s.url)).toEqual(["/mimir/v1/capabilities"]);
      expect(check(r, "mimir").status).toBe("ok");
    });
    it("warns when capabilities needs a token", async () => {
      for (const status of [401, 403]) {
        const url = await serve(status, caps({}));
        const r = await doctor(envFor({ SINDRI_MIMIR_URL: url }));
        expect(check(r, "mimir")).toMatchObject({ status: "warn", required: false });
        expect(check(r, "mimir").detail).toContain("set MIMIR_AUTH_TOKEN");
        await new Promise((res) => srv!.close(res));
        srv = undefined;
      }
    });
    it("fails on a non-JSON body, an HTTP error, or a missing protocolVersion", async () => {
      for (const [status, body] of [
        [200, "<html>"],
        [500, caps({ protocolVersion: 1 })],
        [200, caps({ protocolVersion: "1" })],
      ] as const) {
        const url = await serve(status, body);
        const r = await doctor(envFor({ SINDRI_MIMIR_URL: url }));
        expect(check(r, "mimir")).toMatchObject({ status: "fail", required: true });
        expect(check(r, "mimir").detail).toContain(`(HTTP ${status})`);
        expect(r.ok).toBe(false);
        await new Promise((res) => srv!.close(res));
        srv = undefined;
      }
    });
    it("fails an incompatible protocol major", async () => {
      const url = await serve(200, caps({ protocolVersion: 2, serverVersion: "9.0.0" }));
      const r = await doctor(envFor({ SINDRI_MIMIR_URL: url }));
      expect(check(r, "mimir")).toMatchObject({
        status: "fail",
        detail: "incompatible: server protocol 2, Sindri supports 1",
      });
    });
    it("fails an invalid URL and warns for a remote host under local-only, without a request", async () => {
      const bad = await doctor(envFor({ SINDRI_MIMIR_URL: "not a url" }));
      expect(check(bad, "mimir")).toMatchObject({ status: "fail", detail: "invalid Mimir URL" });
      writeSettings({ mimirUrl: "https://mimir.example.com" });
      const remote = await doctor(envFor());
      expect(check(remote, "mimir")).toMatchObject({
        status: "warn",
        detail: "Mimir target blocked by local-only",
      });
    });
    it("warns when unreachable without echoing URL credentials", async () => {
      const r = await doctor(envFor({ SINDRI_MIMIR_URL: "http://bob:s3cretpw@127.0.0.1:1/" }));
      expect(check(r, "mimir").status).toBe("warn");
      expect(check(r, "mimir").detail).toContain("unreachable at http://127.0.0.1:1");
      expect(JSON.stringify(r)).not.toMatch(/s3cretpw|bob/);
    });
  });
});
