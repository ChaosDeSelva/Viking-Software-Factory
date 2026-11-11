import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./env.js";
import type { ServerProcess } from "./serve.js";

// The real spawnServer, with every started server recorded so a test can reach its process.
const spawned = vi.hoisted(() => [] as ServerProcess[]);
// Lines replayed through the demo's output callback as if the server had printed them.
const serverLines = vi.hoisted(() => [] as [string, "stdout" | "stderr"][]);
vi.mock("./serve.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./serve.js")>();
  return {
    ...actual,
    spawnServer: (...args: Parameters<typeof actual.spawnServer>) => {
      const s = actual.spawnServer(...args);
      spawned.push(s);
      for (const [line, stream] of serverLines) args[2](line, stream);
      return s;
    },
  };
});

const { DEMO_TEST_COMMAND, runDemo } = await import("./demo.js");

const USER_TOKEN = "user-token-that-the-demo-must-not-use";
let home: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let err: string[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  // Real path: the demo resolves its own dir (macOS /var -> /private/var).
  home = realpathSync(mkdtempSync(join(tmpdir(), "mimir-demo-test-")));
  const web = join(home, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>mimir-test-app</title>");
  // The demo creates its directory under os.tmpdir(); point that at this test's own dir.
  vi.stubEnv("TMPDIR", home);
  env = {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    MIMIR_PORT: "0",
    MIMIR_WEB_ROOT: web,
    MIMIR_AUTH_TOKEN: USER_TOKEN,
    MIMIR_DATA_DIR: join(home, "user-data"),
  };
  out = [];
  err = [];
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  serverLines.splice(0);
  for (const s of spawned.splice(0)) {
    s.child.kill("SIGKILL");
    await s.exited;
  }
  rmSync(home, { recursive: true, force: true });
});

async function waitFor<T>(what: string, probe: () => T | undefined, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() > end) {
      throw new Error(
        `timed out waiting for ${what}\nout: ${out.join("\n")}\nerr: ${err.join("\n")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

type Listener = () => void;
const listeners = (sig: "SIGINT" | "SIGTERM") => process.listeners(sig) as unknown as Listener[];

const start = () => {
  const before = { int: listeners("SIGINT"), term: listeners("SIGTERM") };
  const done = runDemo(
    env,
    (l) => out.push(l),
    (l) => err.push(l),
  );
  done.catch(() => undefined);
  const added = (sig: "SIGINT" | "SIGTERM", was: Listener[]) =>
    listeners(sig).filter((l) => !was.includes(l));
  return {
    done,
    before,
    sigint: added("SIGINT", before.int),
    sigterm: added("SIGTERM", before.term),
  };
};
const field = (name: string): string | undefined =>
  out.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
const ready = () => waitFor("the demo to print its token file", () => field("token file"));
const demoDirs = () =>
  readdirSync(home).filter((f) => f.startsWith("mimir-demo-") && f !== "mimir-demo-test");
const noSignalListenersLeft = (before: { int: Listener[]; term: Listener[] }) => {
  expect(listeners("SIGINT")).toEqual(before.int);
  expect(listeners("SIGTERM")).toEqual(before.term);
};

describe("runDemo", () => {
  it("sets up the mission in a throwaway dir, keeps everything inside it, and cleans up on SIGINT", async () => {
    const d = start();
    expect(d.sigint).toHaveLength(1);
    expect(d.sigterm).toHaveLength(1);
    const tokenFile = await ready();
    const url = field("url") as string;
    const missionId = field("mission") as string;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(missionId).toMatch(/^msn_/);
    const root = join(home, demoDirs()[0] as string);
    expect(demoDirs()).toHaveLength(1);
    expect(tokenFile.endsWith(join(demoDirs()[0] as string, "data", "auth-token"))).toBe(true);

    // The demo has its own token: the user's MIMIR_AUTH_TOKEN is neither used nor printed.
    const token = readFileSync(tokenFile, "utf8").trim();
    expect(out.join("\n")).not.toContain(token);
    expect(out.join("\n") + err.join("\n")).not.toContain(USER_TOKEN);
    const get = async (path: string, bearer: string) =>
      fetch(`${url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
    expect((await get("/v1/missions", USER_TOKEN)).status).toBe(401);
    expect((await fetch(`${url}/`)).status).toBe(200);

    const snap = (await (await get("/v1/snapshot", token)).json()) as {
      tasks: { id: string; missionId: string; title: string }[];
      taskDependencies: { taskId: string; dependsOnId: string }[];
      crews: { missionId: string; template: string }[];
    };
    const mine = snap.tasks.filter((t) => t.missionId === missionId);
    expect(mine.map((t) => t.title).sort()).toEqual([
      "Count the files",
      "Print the date",
      "Write the greeting",
    ]);
    const id = (title: string) => mine.find((t) => t.title === title)?.id;
    expect(snap.taskDependencies.map((dep) => [dep.taskId, dep.dependsOnId]).sort()).toEqual(
      [
        [id("Count the files"), id("Write the greeting")],
        [id("Print the date"), id("Count the files")],
      ].sort(),
    );
    expect(snap.crews.map((c) => c.template)).toEqual(["solo"]);
    const projects = (await (await get("/v1/projects", token)).json()) as {
      projects: { repoPath: string; settings: { testCommand?: unknown } }[];
    };
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]?.repoPath).toBe(join(root, "repo"));
    expect(projects.projects[0]?.settings.testCommand).toEqual(DEMO_TEST_COMMAND);

    // Task worktrees belong to the throwaway dir too, not to ~/.mimir-work of the user.
    await waitFor("a task worktree", () =>
      [join(root, "worktrees"), join(home, ".mimir-work", "worktrees")].find(
        (dir) => existsSync(dir) && readdirSync(dir).some((f) => f.startsWith("prj_")),
      ),
    );
    expect(existsSync(join(home, ".mimir-work"))).toBe(false);
    expect(existsSync(join(home, "user-data"))).toBe(false);
    expect(existsSync(join(home, ".mimir"))).toBe(false);

    (d.sigint[0] as () => void)();
    expect(await d.done).toBe(0);
    expect(demoDirs()).toEqual([]);
    noSignalListenersLeft(d.before);
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it("exits 0 and cleans up when interrupted while the server is still starting", async () => {
    const d = start();
    expect(demoDirs()).toHaveLength(1);
    (d.sigterm[0] as () => void)();
    expect(await d.done).toBe(0);
    expect(out).toEqual([]);
    expect(demoDirs()).toEqual([]);
    noSignalListenersLeft(d.before);
  });

  it("passes the server's stderr lines on and keeps its stdout out of the demo's output", async () => {
    serverLines.push(["server warning", "stderr"], ["server request log", "stdout"]);
    const d = start();
    (d.sigterm[0] as () => void)();
    expect(await d.done).toBe(0);
    expect(err).toEqual(["server warning"]);
    expect(out).toEqual([]);
    noSignalListenersLeft(d.before);
  });

  it("fails with exit 3, without leaking the token, when a setup call is refused", async () => {
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) =>
      input.endsWith("/v1/crews")
        ? new Response('{"error":"crew refused"}', { status: 500 })
        : realFetch(input, init),
    );
    const d = start();
    const e = await d.done.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(e).toBeInstanceOf(CliError);
    expect((e as CliError).exitCode).toBe(3);
    expect((e as CliError).message).toBe(
      'demo setup: POST /v1/crews -> 500 {"error":"crew refused"}',
    );
    expect(out).toEqual([]);
    expect(await (spawned[0] as ServerProcess).exited).toBe(0);
    expect(demoDirs()).toEqual([]);
    noSignalListenersLeft(d.before);
  });

  it("returns 3 when the server dies on its own, tolerating an empty response body", async () => {
    const calls: { path: string; key: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const res = await realFetch(input, init);
      const path = new URL(input).pathname;
      calls.push({ path, key: new Headers(init?.headers).get("idempotency-key") });
      return path.endsWith("/start") && res.ok ? new Response("", { status: 200 }) : res;
    });
    const d = start();
    await ready();
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/projects",
      "/v1/missions",
      "/v1/tasks",
      "/v1/tasks",
      "/v1/crews",
      `/v1/missions/${field("mission")}/start`,
    ]);
    // Every mutation carries its own idempotency key.
    expect(new Set(calls.map((c) => c.key)).size).toBe(calls.length);
    expect(calls.every((c) => c.key !== null && c.key !== "")).toBe(true);
    (spawned[0] as ServerProcess).child.kill("SIGKILL");
    expect(await d.done).toBe(3);
    expect(demoDirs()).toEqual([]);
    noSignalListenersLeft(d.before);
  });

  it("returns 0 when the server exits cleanly by itself", async () => {
    const d = start();
    await ready();
    (spawned[0] as ServerProcess).child.kill("SIGTERM");
    expect(await d.done).toBe(0);
    expect(demoDirs()).toEqual([]);
  });

  it("fails without starting a server, and cleans up, when git is not available", async () => {
    const empty = join(home, "empty-bin");
    mkdirSync(empty);
    env = { ...env, PATH: empty, HOME: undefined };
    const d = start();
    await expect(d.done).rejects.toThrow(/git/);
    expect(spawned).toEqual([]);
    expect(demoDirs()).toEqual([]);
    noSignalListenersLeft(d.before);
  });

  it("does not fall back to the CLI's own PATH when the env has none", async () => {
    env = { ...env, PATH: undefined };
    const d = start();
    await expect(d.done).rejects.toThrow(/git/);
    expect(spawned).toEqual([]);
    expect(demoDirs()).toEqual([]);
  });
});
