/**
 * Contract tests against the real server (`buildServer` + in-memory store + FakeRuntime), over a
 * real loopback socket.
 *
 * Two suites, each keyed on a route existing:
 * - A (`GET /v1/events`): health, capabilities, projects, snapshot, events paging/replay, and SSE
 *   resume across a server restart.
 * - B (`GET /v1/missions`, T12): missions, crews, tasks, approvals, sessions, artifacts, usage,
 *   attention.
 * Only a 404 means "route not there yet, skip". Any other probe failure (buildServer throws, a 403,
 * a 500) fails the detection test instead of silently skipping.
 *
 * `buildServer` is loaded through a loose type because its options change as the server grows;
 * the SDK validates every response with the protocol schemas, so each successful call is also a
 * response-schema assertion.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openEventStore, type AppendInput, type EventStore } from "@mimir/core";
import { FakeRuntime } from "@mimir/fake-runtime";
import { MimirError, newId, type EventEnvelope } from "@mimir/protocol";
import { createMimirClient, type MimirClient } from "../src/index.js";

const TOKEN = "live-contract-token-0123456789abcdef";

interface LiveApp {
  listen(opts: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
  server: { address(): { port: number } | string | null };
}
type BuildServer = (opts: Record<string, unknown>) => LiveApp;

async function loadBuildServer(): Promise<BuildServer> {
  const mod = (await import("@mimir/server")) as unknown as { buildServer: BuildServer };
  return mod.buildServer;
}

interface Live {
  app: LiveApp;
  store: EventStore;
  port: number;
  url: string;
  client: MimirClient;
}

async function start(buildServer: BuildServer, store: EventStore, port = 0): Promise<Live> {
  const app = buildServer({
    store,
    ledger: store.commands,
    audit: store.audit,
    runtime: new FakeRuntime(),
    authToken: TOKEN,
  });
  await app.listen({ host: "127.0.0.1", port });
  const addr = app.server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  const url = `http://127.0.0.1:${bound}`;
  return {
    app,
    store,
    port: bound,
    url,
    client: createMimirClient({ baseUrl: url, token: TOKEN }),
  };
}

interface Probe {
  events: boolean;
  missions: boolean;
  error?: unknown;
}

/** 200 → present, 404 → absent, anything else → error. */
async function probeServer(): Promise<Probe> {
  const store = openEventStore(":memory:");
  let live: Live | undefined;
  try {
    live = await start(await loadBuildServer(), store);
    const present = async (path: string) => {
      const res = await fetch(`${live!.url}${path}`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      if (res.status === 404) return false;
      if (res.ok) return true;
      throw new Error(`probe ${path}: HTTP ${res.status} ${await res.text()}`);
    };
    return { events: await present("/v1/events"), missions: await present("/v1/missions") };
  } catch (error) {
    return { events: false, missions: false, error };
  } finally {
    await live?.app.close();
    store.close();
  }
}

const probe = await probeServer();

function eventInput(type: AppendInput["type"], payload: unknown): AppendInput {
  const now = new Date().toISOString();
  return {
    streamId: "live-contract",
    occurredAt: now,
    observedAt: now,
    type,
    source: "contract-test",
    provenance: "observed",
    payload,
  };
}

async function take(it: AsyncIterator<EventEnvelope>, n: number): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = [];
  const deadline = Date.now() + 10_000;
  while (out.length < n) {
    const next = await Promise.race([
      it.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timeout ${out.length}/${n}`)), deadline - Date.now()),
      ),
    ]);
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

function tempRepos() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mimir-sdk-live-")));
  let n = 0;
  return {
    dir,
    /** A fresh git repo (projects are unique per repository). */
    repo(): string {
      const repo = join(dir, `repo-${++n}`);
      mkdirSync(repo);
      execFileSync("git", ["init", "-q", repo]);
      return repo;
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("contract: live server detection", () => {
  it("probes the real server without errors; /v1/events exists on main", () => {
    if (probe.error) throw probe.error;
    expect(probe.events).toBe(true);
    expect(typeof probe.missions).toBe("boolean");
  });
});

describe.skipIf(!probe.events)("contract A: events, projects, snapshot on the real server", () => {
  let buildServer: BuildServer;
  let live: Live;
  let repos: ReturnType<typeof tempRepos>;

  beforeAll(async () => {
    buildServer = await loadBuildServer();
    live = await start(buildServer, openEventStore(":memory:"));
    repos = tempRepos();
  });

  afterAll(async () => {
    await live?.app.close();
    live?.store.close();
    repos?.cleanup();
  });

  it("health, capabilities, projects and snapshot validate against the protocol", async () => {
    const { client } = live;
    expect((await client.health()).status).toMatch(/ok|degraded/);
    expect((await client.capabilities()).protocolVersion).toBe(1);
    const { project } = await client.projects.create({ name: "live", repoPath: repos.repo() });
    expect((await client.projects.list()).projects.map((p) => p.id)).toContain(project.id);
    const snap = await client.snapshot();
    expect(snap.projects.map((p) => p.id)).toContain(project.id);
    expect(snap.cursor).toBe(live.store.latestCursor());
  });

  it("idempotent replay returns the same body; a changed body is a mismatch", async () => {
    const body = { name: "idem", repoPath: repos.repo() };
    const a = await live.client.projects.create(body, { idempotencyKey: "live-idem-1" });
    const b = await live.client.projects.create(body, { idempotencyKey: "live-idem-1" });
    expect(b).toEqual(a);
    const err: unknown = await live.client.projects
      .create({ ...body, name: "other" }, { idempotencyKey: "live-idem-1" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MimirError);
    expect(err).toMatchObject({ code: "idempotency_replay_mismatch" });
  });

  it("events.list pages and replayAll returns the server's final cursor", async () => {
    for (let i = 0; i < 5; i++) live.store.append(eventInput("summary.created", {}));
    const page = await live.client.events.list({ limit: 2 });
    expect(page.events).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    const all = await live.client.events.replayAll({ limit: 2 });
    expect(all.events.length).toBeGreaterThanOrEqual(5);
    expect(all.cursor).toBe(live.store.latestCursor());
    const empty = await live.client.events.replayAll({ from: all.cursor });
    expect(empty).toEqual({ events: [], cursor: live.store.latestCursor() });
  });

  it("replayAll then stream loses nothing appended in between", async () => {
    const r = await live.client.events.replayAll();
    const between = live.store.append(eventInput("summary.created", {}));
    const ac = new AbortController();
    const stream = live.client.events.stream({ cursor: r.cursor, signal: ac.signal });
    const it = stream[Symbol.asyncIterator]();
    expect((await take(it, 1))[0]!.id).toBe(between.id);
    ac.abort();
  });

  it("a cursor-less stream resumes across a restart before its first event, without loss", async () => {
    const statuses: string[] = [];
    const ac = new AbortController();
    const stream = live.client.events.stream({
      signal: ac.signal,
      backoff: { initialMs: 20, maxMs: 200 },
      onStatus: (s) => statuses.push(s),
    });
    const it = stream[Symbol.asyncIterator]();
    const pending = take(it, 2);
    const deadline = Date.now() + 5_000;
    while (stream.cursor === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(stream.cursor).toBe(live.store.latestCursor());

    await live.app.close(); // kill before any event; the store survives
    const missed = live.store.append(eventInput("summary.created", {}));
    live = await start(buildServer, live.store, live.port);
    const after = live.store.append(eventInput("summary.created", {}));
    expect((await pending).map((e) => e.id)).toEqual([missed.id, after.id]);
    ac.abort();
    expect(statuses).toContain("reconnecting");
  });

  it("stream resumes across a server restart on the same port with no duplicates or gaps", async () => {
    const begin = live.store.latestCursor();
    const ac = new AbortController();
    const stream = live.client.events.stream({
      cursor: begin,
      signal: ac.signal,
      backoff: { initialMs: 20, maxMs: 200 },
    });
    const it = stream[Symbol.asyncIterator]();
    const appended: EventEnvelope[] = [];
    for (let i = 0; i < 3; i++) appended.push(live.store.append(eventInput("summary.created", {})));
    const before = await take(it, 3);

    await live.app.close(); // kill mid-stream; the store survives
    for (let i = 0; i < 3; i++) appended.push(live.store.append(eventInput("summary.created", {})));
    live = await start(buildServer, live.store, live.port);
    const after = await take(it, 3);
    appended.push(live.store.append(eventInput("summary.created", {})));
    const tail = await take(it, 1);
    ac.abort();

    const got = [...before, ...after, ...tail].map((e) => e.id);
    expect(got).toEqual(appended.map((e) => e.id));
  });
});

describe.skipIf(!probe.missions)("contract B: missions and T12 routes on the real server", () => {
  let live: Live;
  let repos: ReturnType<typeof tempRepos>;

  beforeAll(async () => {
    live = await start(await loadBuildServer(), openEventStore(":memory:"));
    repos = tempRepos();
  });

  afterAll(async () => {
    await live?.app.close();
    live?.store.close();
    repos?.cleanup();
  });

  it("exercises the mission-related client methods; responses validate", async () => {
    const { client } = live;
    const { project } = await client.projects.create({ name: "live", repoPath: repos.repo() });
    const { mission } = await client.missions.create({ projectId: project.id, objective: "o" });
    expect((await client.missions.list({ projectId: project.id })).missions).toHaveLength(1);
    expect((await client.missions.get(mission.id)).mission.id).toBe(mission.id);
    const { crew } = await client.crews.create({
      missionId: mission.id,
      template: "solo",
      members: [{ role: "implementer", agentKind: "claude" }],
    });
    expect((await client.crews.list({ missionId: mission.id })).crews.map((c) => c.id)).toContain(
      crew.id,
    );
    const paused = await client.crews.pause(crew.id, { expectedVersion: crew.version });
    expect(paused.crew.schedulingPaused).toBe(true);
    await expect(
      client.crews.resume(crew.id, { expectedVersion: crew.version }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await client.crews.resume(crew.id)).crew.schedulingPaused).toBe(false);
    const { task } = await client.tasks.create({
      missionId: mission.id,
      title: "Inspect task",
      brief: "Fixture",
    });
    expect((await client.tasks.get(task.id)).task.id).toBe(task.id);
    await expect(client.tasks.verify(task.id)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    await expect(client.sessions.get(newId("ses"))).rejects.toMatchObject({ code: "not_found" });
    expect((await client.missions.start(mission.id)).operationId).toMatch(/^op_/);
    expect(Array.isArray((await client.tasks.list({ missionId: mission.id })).tasks)).toBe(true);
    expect(Array.isArray((await client.approvals.list()).approvals)).toBe(true);
    const usage = await client.usage.get({ missionId: mission.id });
    expect(usage.totals.samples).toBeGreaterThanOrEqual(0);
    expect(Array.isArray((await client.attention.list()).items)).toBe(true);

    // Unknown ids: the server's error code comes back as MimirError.
    for (const call of [
      () => client.artifacts.get(newId("art")),
      () => client.tasks.retry(newId("tsk")),
      () => client.approvals.decide(newId("apr"), { decision: "approved" }),
      () => client.sessions.input(newId("ses"), { text: "hi" }),
      () => client.sessions.stop(newId("ses"), { mode: "soft" }),
      () => client.sessions.terminal(newId("ses"), { lines: 10 }),
    ]) {
      const err: unknown = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MimirError);
    }
    expect((await client.missions.cancel(mission.id, { reason: "done" })).commandId).toMatch(
      /^cmd_/,
    );
  });
});
