import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import {
  ApiErrorBodySchema,
  CreateProjectResponseSchema,
  ListProjectsResponseSchema,
} from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";

const servers: TestServer[] = [];
const track = (s: TestServer) => (servers.push(s), s);
let tmp: ReturnType<typeof tempGitRepo>;
beforeEach(() => {
  tmp = tempGitRepo();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  tmp.cleanup();
});

const post = (s: TestServer, body: unknown, key: string | null = "key-1") =>
  s.app.inject({
    method: "POST",
    url: "/v1/projects",
    headers: key === null ? AUTH : { ...AUTH, "idempotency-key": key },
    payload: body as Record<string, unknown>,
  });

const code = (res: { json(): unknown }) => ApiErrorBodySchema.parse(res.json()).error.code;

describe("POST /v1/projects idempotency", () => {
  it("returns 422 when the Idempotency-Key header is missing", async () => {
    const s = track(makeServer());
    const res = await post(s, { name: "p", repoPath: tmp.repo }, null);
    expect(res.statusCode).toBe(422);
    expect(code(res)).toBe("validation_failed");
    expect(s.store.audit.list()).toEqual([]);
  });

  it("checks auth before the idempotency key", async () => {
    const s = track(makeServer());
    const res = await s.app.inject({ method: "POST", url: "/v1/projects", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("creates once; a replay returns the identical body with Idempotency-Replayed: true", async () => {
    const s = track(makeServer());
    const first = await post(s, { name: "p", repoPath: tmp.repo });
    expect(first.statusCode).toBe(201);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();
    const { project } = CreateProjectResponseSchema.parse(first.json());
    expect(project).toMatchObject({ name: "p", repoPath: tmp.repo, settings: {}, version: 0 });

    const replay = await post(s, { name: "p", repoPath: tmp.repo });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body).toBe(first.body);

    const list = await s.app.inject({ method: "GET", url: "/v1/projects", headers: AUTH });
    expect(ListProjectsResponseSchema.parse(list.json()).projects).toEqual([project]);
  });

  it("returns 409 idempotency_replay_mismatch when the key is reused with a different body", async () => {
    const s = track(makeServer());
    await post(s, { name: "p", repoPath: tmp.repo });
    const res = await post(s, { name: "other", repoPath: tmp.repo });
    expect(res.statusCode).toBe(409);
    expect(code(res)).toBe("idempotency_replay_mismatch");
  });

  it("replays a recorded failure with the same status and body", async () => {
    const s = track(makeServer());
    const first = await post(s, { name: "p", repoPath: join(tmp.dir, "missing") }, "k-fail");
    expect(first.statusCode).toBe(422);
    const again = await post(s, { name: "p", repoPath: join(tmp.dir, "missing") }, "k-fail");
    expect(again.statusCode).toBe(422);
    expect(again.headers["idempotency-replayed"]).toBe("true");
    expect(again.body).toBe(first.body);
  });
});

describe("POST /v1/projects validation", () => {
  it("rejects an invalid body with 422 and details.issues", async () => {
    const s = track(makeServer());
    const res = await post(s, { name: "", repoPath: tmp.repo, extra: 1 });
    expect(res.statusCode).toBe(422);
    const body = ApiErrorBodySchema.parse(res.json());
    expect(body.error.details).toMatchObject({ issues: expect.any(Array) });
  });

  it("rejects a missing path and a non-git directory", async () => {
    const s = track(makeServer());
    const missing = await post(s, { name: "p", repoPath: join(tmp.dir, "nope") }, "a");
    expect(missing.statusCode).toBe(422);
    const plain = join(tmp.dir, "plain");
    mkdirSync(plain);
    const notGit = await post(s, { name: "p", repoPath: plain }, "b");
    expect(notGit.statusCode).toBe(422);
    expect(notGit.json()).toMatchObject({ error: { details: { reason: "not_a_git_repo" } } });
  });

  it("stores the repository top level when given a subdirectory", async () => {
    const s = track(makeServer());
    const sub = join(tmp.repo, "pkg");
    mkdirSync(sub);
    const res = await post(s, { name: "p", repoPath: sub });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ project: { repoPath: tmp.repo } });
  });

  it("rejects repo paths outside MIMIR_ALLOWED_ROOTS, resolving symlinks", async () => {
    const allowed = join(tmp.dir, "allowed");
    mkdirSync(allowed);
    const s = track(makeServer({ allowedRoots: [allowed] }));
    const outside = await post(s, { name: "p", repoPath: tmp.repo }, "a");
    expect(outside.statusCode).toBe(403);
    expect(code(outside)).toBe("policy_denied");

    const link = join(allowed, "link");
    symlinkSync(tmp.repo, link);
    const viaLink = await post(s, { name: "p", repoPath: link }, "b");
    expect(viaLink.statusCode).toBe(403);
    expect(code(viaLink)).toBe("policy_denied");
  });

  it("accepts a repo inside an allowed root", async () => {
    const s = track(makeServer({ allowedRoots: [tmp.dir] }));
    expect((await post(s, { name: "p", repoPath: tmp.repo })).statusCode).toBe(201);
  });

  it("rejects a second project for the same repository with 409 conflict", async () => {
    const s = track(makeServer());
    await post(s, { name: "p", repoPath: tmp.repo }, "a");
    const dup = await post(s, { name: "p2", repoPath: tmp.repo }, "b");
    expect(dup.statusCode).toBe(409);
    expect(code(dup)).toBe("conflict");
  });
});

describe("POST /v1/projects audit, snapshot and persistence", () => {
  it("writes an audit entry for success and for failure", async () => {
    const s = track(makeServer());
    const ok = await post(s, { name: "p", repoPath: tmp.repo }, "a");
    const id = (ok.json() as { project: { id: string } }).project.id;
    await post(s, { name: "p", repoPath: join(tmp.dir, "nope") }, "b");
    expect(s.store.audit.list()).toEqual([
      expect.objectContaining({
        actor: "operator",
        action: "project.create",
        target: id,
        decision: "succeeded",
      }),
      expect.objectContaining({
        actor: "operator",
        action: "project.create",
        decision: "failed",
        reason: expect.stringContaining("validation_failed"),
      }),
    ]);
  });

  it("is reflected in GET /v1/snapshot", async () => {
    const s = track(makeServer());
    const ok = await post(s, { name: "p", repoPath: tmp.repo });
    const snap = await s.app.inject({ method: "GET", url: "/v1/snapshot", headers: AUTH });
    expect(snap.statusCode).toBe(200);
    expect(snap.json()).toMatchObject({ projects: [(ok.json() as { project: unknown }).project] });
  });

  it("fails commands left in flight by a previous process, so their key replays the failure", async () => {
    const dbPath = join(tmp.dir, "mimir.db");
    const store = openEventStore(dbPath);
    const body = { name: "p", repoPath: tmp.repo };
    store.commands.begin("k-crash", "project.create", { params: {}, body });
    const s = track(makeServer({}, store));
    expect(store.commands.listInFlight()).toEqual([]);
    const replay = await post(s, body, "k-crash");
    expect(replay.statusCode).toBe(500);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json()).toMatchObject({
      error: { code: "internal", details: { interrupted: true } },
    });
    expect(store.audit.list()).toEqual([
      expect.objectContaining({
        actor: "system",
        action: "project.create",
        decision: "failed",
        reason: expect.stringContaining("interrupted"),
      }),
    ]);
  });

  it("survives a restart on the same database", async () => {
    const dbPath = join(tmp.dir, "mimir.db");
    const s1 = makeServer({}, openEventStore(dbPath));
    const ok = await post(s1, { name: "p", repoPath: tmp.repo });
    await s1.close();
    const s2 = track(makeServer({}, openEventStore(dbPath)));
    const list = await s2.app.inject({ method: "GET", url: "/v1/projects", headers: AUTH });
    expect(list.json()).toEqual({ projects: [(ok.json() as { project: unknown }).project] });
    const replay = await post(s2, { name: "p", repoPath: tmp.repo });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
  });
});

describe("projects are event-sourced (T12)", () => {
  it("POST /v1/projects appends project.created and the read model folds it", async () => {
    const s = track(makeServer());
    const ok = await post(s, { name: "p", repoPath: tmp.repo, settings: { a: 1 } });
    const { project } = CreateProjectResponseSchema.parse(ok.json());
    const events = s.store.read({ limit: 100, types: ["project.created"] }).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      streamId: `project:${project.id}`,
      provenance: "derived",
      payload: { project },
    });
    expect(s.app.mimir.readModel.projects.get(project.id)).toEqual(project);
  });

  it("migrates legacy server_projects rows into project.created events exactly once", async () => {
    const dbPath = join(tmp.dir, "mimir.db");
    const store = openEventStore(dbPath);
    const legacy = {
      id: "prj_01J00000000000000000000000",
      name: "legacy",
      repoPath: tmp.repo,
      settings: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      version: 0,
    };
    const db = store.connection();
    db.exec(`CREATE TABLE server_projects (
      id TEXT PRIMARY KEY, repo_path TEXT NOT NULL UNIQUE, data TEXT NOT NULL, created_at TEXT NOT NULL)`);
    db.prepare("INSERT INTO server_projects VALUES (?, ?, ?, ?)").run(
      legacy.id,
      legacy.repoPath,
      JSON.stringify(legacy),
      legacy.createdAt,
    );
    const s1 = makeServer({}, store);
    const list = await s1.app.inject({ method: "GET", url: "/v1/projects", headers: AUTH });
    expect(list.json()).toEqual({ projects: [legacy] });
    await s1.app.close();
    const s2 = track(makeServer({}, store));
    expect(store.read({ limit: 100, types: ["project.created"] }).events).toHaveLength(1);
    const dup = await post(s2, { name: "again", repoPath: tmp.repo });
    expect(dup.statusCode).toBe(409);
  });
});
