import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEventStore, type EventStore, type PolicyRule } from "@mimir/core";
import { FakeRuntime, ManualClock, type ScriptStep } from "@mimir/fake-runtime";
import {
  newId,
  type EventEnvelope,
  type EventType,
  type RuntimeAdapter,
  type Task,
} from "@mimir/protocol";
import type { FastifyInstance } from "fastify";
import { buildServer, type BuildServerOptions } from "../index.js";
import { AUTH, TOKEN } from "../test-helpers.js";

/** Test-only: a temp git repo with a passing `npm test` script, plus a data dir. */
export function tempProject(): { root: string; repo: string; dataDir: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mimir-orch-")));
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      env: { PATH: process.env["PATH"] ?? "", HOME: root },
      stdio: "ignore",
    });
  git("init", "-q", "-b", "main");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "demo", private: true, scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  git("add", "package.json");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  return { root, repo, dataDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Loosely typed JSON for test assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only convenience
export type Json = any;

/** Default test command for harness projects: allowlisted (`cat` on a worktree file), exits 0. */
export const FAST_TEST_COMMAND = ["cat", "package.json"];

export const T0 = Date.parse("2026-10-14T08:00:00.000Z");

export interface Harness {
  app: FastifyInstance;
  store: EventStore;
  clock: ManualClock;
  fake: FakeRuntime;
  repo: string;
  dataDir: string;
  key(): string;
  post(url: string, body?: unknown, key?: string): Promise<{ status: number; json: Json }>;
  get(url: string): Promise<{ status: number; json: Json }>;
  tick(): Promise<void>;
  /** Moves the fake runtime clock (and the server clock) forward and waits for the orchestrator. */
  advance(ms: number): Promise<void>;
  idle(): Promise<void>;
  events(types?: EventType[]): EventEnvelope[];
  task(id: string): Task;
  /** Builds a second server on the same store and runtime (a restart). */
  restart(overrides?: Partial<BuildServerOptions>): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  script?: readonly ScriptStep[];
  policies?: readonly PolicyRule[];
  overrides?: Partial<BuildServerOptions>;
  /** Wrap the fake runtime (e.g. to inject events it cannot produce). */
  wrapRuntime?: (fake: FakeRuntime) => RuntimeAdapter;
}

export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const project = tempProject();
  const clock = new ManualClock();
  const fake = new FakeRuntime(opts.script ? { clock, script: opts.script } : { clock });
  const runtime = opts.wrapRuntime ? opts.wrapRuntime(fake) : fake;
  const store = openEventStore(":memory:");
  const now = () => new Date(T0 + clock.now());
  let n = 0;
  const make = (overrides: Partial<BuildServerOptions> = {}) =>
    buildServer({
      store,
      ledger: store.commands,
      audit: store.audit,
      runtime,
      authToken: TOKEN,
      // app.inject() sends `Host: localhost:80` (same as test-helpers.ts).
      publicOrigins: ["http://localhost:80"],
      now,
      tickMs: 0,
      dataDir: project.dataDir,
      ...(opts.policies ? { policies: opts.policies } : {}),
      ...opts.overrides,
      ...overrides,
    });
  let app = make();
  await app.ready();
  const h: Harness = {
    get app() {
      return app;
    },
    store,
    clock,
    fake,
    repo: project.repo,
    dataDir: project.dataDir,
    key: () => `k-${++n}-${newId("op")}`,
    async post(url, body = {}, key = h.key()) {
      const res = await app.inject({
        method: "POST",
        url,
        headers: { ...AUTH, "idempotency-key": key },
        payload: body as Record<string, unknown>,
      });
      return { status: res.statusCode, json: res.body.length > 0 ? res.json() : null };
    },
    async get(url) {
      const res = await app.inject({ method: "GET", url, headers: AUTH });
      return { status: res.statusCode, json: res.json() };
    },
    async tick() {
      await app.mimir.orchestrator.tick();
      await app.mimir.orchestrator.idle();
    },
    async advance(ms) {
      clock.advance(ms);
      await app.mimir.orchestrator.idle();
    },
    idle: () => app.mimir.orchestrator.idle(),
    events(types) {
      return store.read({ limit: 100_000, ...(types ? { types } : {}) }).events;
    },
    task(id) {
      const t = app.mimir.readModel.tasks.get(id);
      if (!t) throw new Error(`no task ${id}`);
      return t;
    },
    async restart(overrides) {
      await app.close();
      app = make(overrides);
      await app.ready();
    },
    async close() {
      await app.close();
      store.close();
      project.cleanup();
    },
  };
  return h;
}

/** Creates project → mission → crew (shell agents). Returns their ids. */
export async function setupMission(
  h: Harness,
  crew: { maxConcurrentTasks?: number; maxAttemptsPerTask?: number } = {},
  projectSettings: Record<string, unknown> = {},
  budget?: Record<string, unknown>,
): Promise<{ projectId: string; missionId: string; crewId: string }> {
  const p = await h.post("/v1/projects", {
    name: "demo",
    repoPath: h.repo,
    // A fast allowlisted verification (no npm start-up) unless the test picks its own.
    settings: { testCommand: FAST_TEST_COMMAND, ...projectSettings },
  });
  if (p.status !== 201) throw new Error(`project: ${JSON.stringify(p.json)}`);
  const m = await h.post("/v1/missions", {
    projectId: p.json.project.id,
    objective: "ship the demo",
    ...(budget ? { budget } : {}),
  });
  if (m.status !== 201) throw new Error(`mission: ${JSON.stringify(m.json)}`);
  const c = await h.post("/v1/crews", {
    missionId: m.json.mission.id,
    template: "solo",
    limits: { maxConcurrentTasks: 2, ...crew },
    members: [{ role: "implementer", agentKind: "shell" }],
  });
  if (c.status !== 201) throw new Error(`crew: ${JSON.stringify(c.json)}`);
  return { projectId: p.json.project.id, missionId: m.json.mission.id, crewId: c.json.crew.id };
}

export async function createTask(
  h: Harness,
  missionId: string,
  title: string,
  instruction: string,
  dependsOn: string[] = [],
): Promise<string> {
  const res = await h.post("/v1/tasks", { missionId, title, brief: instruction, dependsOn });
  if (res.status !== 201) throw new Error(`task: ${JSON.stringify(res.json)}`);
  return res.json.task.id as string;
}
