import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MAIN = new URL("../dist/main.js", import.meta.url).pathname;
let home: string;
let data: string;
type Proc = Promise<{ exitCode?: number | undefined }> & {
  kill(signal?: NodeJS.Signals): boolean;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
};
const running: Proc[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mimir-serve-"));
  data = join(home, "data");
});
afterEach(async () => {
  for (const p of running.splice(0)) {
    p.kill("SIGKILL");
    await p.catch(() => undefined);
  }
  rmSync(home, { recursive: true, force: true });
});

interface Live {
  proc: Proc;
  output(): string;
  waitFor(re: RegExp, ms?: number): Promise<RegExpExecArray>;
}
function launch(args: string[], env: Record<string, string> = {}): Live {
  const proc: Proc = execa(process.execPath, [MAIN, ...args], {
    reject: false,
    extendEnv: false,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: home,
      MIMIR_DATA_DIR: data,
      MIMIR_PORT: "0",
      ...env,
    },
  });
  running.push(proc);
  let out = "";
  proc.stdout?.on("data", (d: Buffer | string) => (out += d.toString()));
  proc.stderr?.on("data", (d: Buffer | string) => (out += d.toString()));
  return {
    proc,
    output: () => out,
    async waitFor(re, ms = 30_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = re.exec(out);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${re}; output so far:\n${out}`);
    },
  };
}

const webRootWith = (): string => {
  const root = join(home, "web");
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>mimir-test-app</title>");
  writeFileSync(join(root, "assets", "a.js"), "1");
  return root;
};

const api = async (url: string, token: string, path: string, init: RequestInit = {}) =>
  fetch(`${url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

describe("mimir start", () => {
  it("serves the web app and the API on one origin, with auth untouched", async () => {
    const l = launch(["start"], { MIMIR_WEB_ROOT: webRootWith() });
    const url = (await l.waitFor(/listening on (http:\/\/\S+)/))[1] as string;
    const html = await fetch(`${url}/`);
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("mimir-test-app");
    expect((await fetch(`${url}/missions/abc`)).status).toBe(200); // SPA fallback
    expect((await fetch(`${url}/assets/a.js`)).headers.get("content-type")).toContain("javascript");
    expect((await fetch(`${url}/v1/missions`)).status).toBe(401);
    const token = readFileSync(join(data, "auth-token"), "utf8").trim();
    expect((await api(url, token, "/v1/missions")).status).toBe(200);
    l.proc.kill("SIGTERM");
    expect((await l.proc).exitCode).toBe(0);
  });

  it("starts API-only with a warning when the web app is not built", async () => {
    const l = launch(["start"], { MIMIR_WEB_ROOT: join(home, "nope") });
    const url = (await l.waitFor(/listening on (http:\/\/\S+)/))[1] as string;
    expect(l.output()).toMatch(/web app not found/);
    expect((await fetch(`${url}/v1/health`)).status).toBe(200);
    expect((await fetch(`${url}/`)).status).toBe(401);
  });

  it("reads host and port from config.json written by `mimir init`, env wins", async () => {
    const cfgDir = data;
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ host: "127.0.0.1", port: 0 }));
    const l = launch(["start"], { MIMIR_PORT: "" });
    await l.waitFor(/listening on http:\/\/127\.0\.0\.1:\d+/);
  });

  it("exits 3 when the server cannot start", async () => {
    const l = launch(["start"], { MIMIR_PORT: "not-a-port" });
    const r = await l.proc;
    expect(r.exitCode).toBe(3);
    expect(l.output()).toMatch(/MIMIR_PORT/);
  });

  it("exits 2 on an invalid --runtime", async () => {
    const r = await launch(["start", "--runtime", "bogus"]).proc;
    expect(r.exitCode).toBe(2);
  });
});

describe("mimir demo", () => {
  it("creates a temp repo, a shell crew and a 3-task mission, and prints the URL and mission id", async () => {
    const l = launch(["demo"], { MIMIR_WEB_ROOT: webRootWith() });
    const m = await l.waitFor(
      /url: (http:\/\/\S+)\n[\s\S]*mission: (msn_\w+)\n[\s\S]*token file: (\S+)/,
    );
    const [, url, missionId, tokenFile] = m as unknown as [string, string, string, string];
    const token = readFileSync(tokenFile, "utf8").trim();
    expect((await fetch(`${url}/`)).status).toBe(200);

    const mission = (await (await api(url, token, `/v1/missions/${missionId}`)).json()) as {
      mission: { id: string; projectId: string };
    };
    expect(mission.mission.id).toBe(missionId);
    const snap = (await (await api(url, token, "/v1/snapshot")).json()) as {
      tasks: { id: string; missionId: string }[];
      taskDependencies: { taskId: string; dependsOnId: string }[];
      crews: { missionId: string; template: string }[];
    };
    const mine = snap.tasks.filter((t) => t.missionId === missionId);
    expect(mine).toHaveLength(3);
    const ids = new Set(mine.map((t) => t.id));
    expect(snap.taskDependencies.filter((d) => ids.has(d.taskId))).toHaveLength(2);
    expect(snap.crews.filter((c) => c.missionId === missionId).map((c) => c.template)).toEqual([
      "solo",
    ]);

    const projects = (await (await api(url, token, "/v1/projects")).json()) as {
      projects: { repoPath: string; settings: { testCommand?: unknown } }[];
    };
    const project = projects.projects[0]!;
    expect(project.settings.testCommand).toEqual(["npm", "test"]);
    expect(existsSync(join(project.repoPath, ".git"))).toBe(true);

    // Nothing is auto-approved: every approval in the system is still pending (or absent).
    const approvals = (await (await api(url, token, "/v1/approvals")).json()) as {
      approvals: { status: string }[];
    };
    expect(approvals.approvals.filter((a) => a.status !== "pending")).toEqual([]);

    l.proc.kill("SIGTERM");
    const r = await l.proc;
    expect(r.exitCode).toBe(0);
    expect(readdirSync(home).filter((f) => f.startsWith("mimir-demo-"))).toEqual([]);
  });
});
