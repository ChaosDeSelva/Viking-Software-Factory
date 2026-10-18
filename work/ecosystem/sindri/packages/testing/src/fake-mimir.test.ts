import { createMimirClient, isMimirError, type MimirClient } from "@mimir/sdk";
import {
  generateOpenApi,
  parseEvent,
  type EventEnvelope,
  type MissionId,
  type ProjectId,
  type TaskId,
} from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeMimir, type FakeMimir } from "./fake-mimir.js";

let fake: FakeMimir | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function boot(options: Parameters<typeof createFakeMimir>[0] = {}) {
  fake = await createFakeMimir({ stepDelayMs: 0, ...options });
  const client = createMimirClient({ baseUrl: fake.url, token: fake.token });
  return { fake, client };
}

async function post(f: FakeMimir, path: string, body: unknown, key = "k-" + Math.random()) {
  return fetch(f.url + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

async function setup(client: MimirClient, f: FakeMimir, titles: string[], deps: number[][] = []) {
  const { project } = await client.projects.create({ name: "p", repoPath: "/tmp/p" });
  const { mission } = await client.missions.create({ projectId: project.id, objective: "o" });
  const { crew } = await client.crews.create({
    missionId: mission.id,
    template: "t",
    members: [{ role: "implementer", agentKind: "shell" }],
    limits: { maxAttemptsPerTask: 3 },
  });
  const ids: TaskId[] = [];
  for (const [i, title] of titles.entries()) {
    const res = await post(f, "/v1/tasks", {
      missionId: mission.id,
      crewId: crew.id,
      title,
      brief: `do ${title}`,
      dependsOn: (deps[i] ?? []).map((d) => ids[d]),
    });
    expect(res.status).toBe(201);
    ids.push(((await res.json()) as { task: { id: TaskId } }).task.id);
  }
  return { projectId: project.id as ProjectId, missionId: mission.id as MissionId, ids };
}

async function collectUntil(
  client: MimirClient,
  missionId: MissionId,
  done: (e: EventEnvelope) => boolean,
): Promise<EventEnvelope[]> {
  const ac = new AbortController();
  const out: EventEnvelope[] = [];
  const { events, cursor } = await client.events.replayAll({ missionId });
  out.push(...events);
  if (events.some(done)) return out;
  const stream = client.events.stream({
    missionId,
    signal: ac.signal,
    ...(cursor ? { cursor } : {}),
  });
  for await (const e of stream) {
    out.push(e);
    if (done(e)) break;
  }
  ac.abort();
  return out;
}

describe("createFakeMimir", () => {
  it("returns a valid SDK cursor when an event filter has no matches", async () => {
    const { client } = await boot();
    const page = await client.events.list({ types: ["approval.consumed"] });
    expect(page.events).toEqual([]);
    expect(page.lastCursor).toEqual(expect.any(String));
  });
  it("only serves routes that exist in the protocol's OpenAPI document", async () => {
    const { fake } = await boot();
    const doc = generateOpenApi() as unknown as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([p, ops]) =>
        Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`),
      ),
    );
    for (const route of fake.routes) {
      expect(documented.has(route)).toBe(true);
    }
    expect(fake.routes).toContain("POST /v1/missions");
    expect(fake.routes).toContain("GET /v1/events/stream");
  });

  it("serves artifact bytes with the recorded hash, standard kinds, and no git.commit_observed", async () => {
    const { fake, client } = await boot();
    const { missionId } = await setup(client, fake, ["a"]);
    await client.missions.start(missionId);
    await vi.waitFor(() => expect(fake.tasks()[0]!.status).toBe("completed"), { timeout: 5000 });
    expect(
      fake
        .artifacts()
        .map((a) => a.kind)
        .sort(),
    ).toEqual(["changed-files", "diff", "test.output"]);
    const manifest = fake.artifacts().find((a) => a.kind === "changed-files")!;
    const { bytes, hash, contentType } = await client.artifacts.content(manifest.id);
    expect(contentType).toBe("application/json");
    expect(hash).toBe(manifest.hash);
    expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
      headSha: fake.headShaOf(manifest.taskId),
    });
    expect(fake.events().map((e) => e.type)).not.toContain("git.commit_observed");
  });

  it("creates a mission's task DAG from POST /v1/missions { tasks }", async () => {
    const { fake, client } = await boot();
    const { project } = await client.projects.create({ name: "p", repoPath: "/tmp/p" });
    const res = await client.missions.create({
      projectId: project.id,
      objective: "o",
      tasks: [{ title: "a", brief: "do a", acceptanceCriteria: ["x", "y"] }],
    });
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks![0]!.acceptance).toBe("x\ny");
    expect(fake.creates.tasks).toBe(1);
  });

  it("requires the bearer token except on /v1/health", async () => {
    const { fake } = await boot();
    expect((await fetch(fake.url + "/v1/health")).status).toBe(200);
    const res = await fetch(fake.url + "/v1/projects");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unauthorized");
  });

  it("validates requests with the protocol schemas", async () => {
    const { fake } = await boot();
    const res = await post(fake, "/v1/missions", { projectId: "nope", objective: "" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );
    const noKey = await fetch(fake.url + "/v1/projects", {
      method: "POST",
      headers: { authorization: `Bearer ${fake.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "p", repoPath: "/r" }),
    });
    expect(noKey.status).toBe(422);
  });

  it("replays idempotent mutations without creating twice, and rejects a changed body", async () => {
    const { fake, client } = await boot();
    const a = await client.projects.create(
      { name: "p", repoPath: "/r" },
      { idempotencyKey: "same" },
    );
    const b = await client.projects.create(
      { name: "p", repoPath: "/r" },
      { idempotencyKey: "same" },
    );
    expect(b.project.id).toBe(a.project.id);
    expect(fake.creates.projects).toBe(1);
    await expect(
      client.projects.create({ name: "other", repoPath: "/r" }, { idempotencyKey: "same" }),
    ).rejects.toSatisfy((e) => isMimirError(e) && e.code === "idempotency_replay_mismatch");
  });

  it("creates tasks with dependencies and lists them", async () => {
    const { fake, client } = await boot();
    const { missionId, ids } = await setup(client, fake, ["a: one", "b: two"], [[], [0]]);
    const { tasks } = await client.tasks.list({ missionId });
    expect(tasks.map((t) => t.id)).toEqual(ids);
    expect(tasks.every((t) => t.status === "pending" && t.maxAttempts === 3)).toBe(true);
    expect(fake.creates.tasks).toBe(2);
    const bad = await post(fake, "/v1/tasks", { missionId, title: "x", dependsOn: ["tsk_bad"] });
    expect(bad.status).toBe(422);
  });

  it("runs a mission to completion honouring dependencies, with valid protocol events", async () => {
    const { fake, client } = await boot();
    const { missionId, ids } = await setup(client, fake, ["a: one", "b: two"], [[], [0]]);
    await client.missions.start(missionId);
    const events = await collectUntil(client, missionId, (e) => e.type === "mission.completed");
    for (const e of events) expect(() => parseEvent(e)).not.toThrow();
    const order = events.filter((e) => e.type === "task.completed").map((e) => e.taskId);
    expect(order).toEqual(ids);
    const startedB = events.findIndex((e) => e.type === "task.leased" && e.taskId === ids[1]);
    const completedA = events.findIndex((e) => e.type === "task.completed" && e.taskId === ids[0]);
    expect(startedB).toBeGreaterThan(completedA);
    const kinds = events
      .filter((e) => e.type === "artifact.recorded")
      .map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toContain("diff");
    const artifactId = (
      events.find((e) => e.type === "artifact.recorded")!.payload as { artifactId: string }
    ).artifactId;
    const { artifact } = await client.artifacts.get(artifactId as never);
    expect(artifact.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("scripts failures that wait for an explicit retry", async () => {
    const { fake, client } = await boot({
      scripts: { a: [{ kind: "fail", reason: "boom" }, { kind: "complete" }] },
    });
    const { missionId, ids } = await setup(client, fake, ["a: one"]);
    await client.missions.start(missionId);
    await collectUntil(client, missionId, (e) => e.type === "task.failed");
    await client.tasks.retry(ids[0]!);
    const events = await collectUntil(client, missionId, (e) => e.type === "mission.completed");
    const types = events.filter((e) => e.taskId === ids[0]).map((e) => e.type);
    expect(types).toContain("task.retried");
    expect(types.at(-1)).toBe("task.completed");
  });

  it("scripts approvals that block until a decision", async () => {
    const { fake, client } = await boot({
      scripts: { a: [{ kind: "approval", action: "shell.destructive" }, { kind: "complete" }] },
    });
    const { missionId } = await setup(client, fake, ["a: one"]);
    await client.missions.start(missionId);
    const events = await collectUntil(client, missionId, (e) => e.type === "approval.requested");
    const req = events.find((e) => e.type === "approval.requested")!;
    const { approvals } = await client.approvals.list({ status: "pending" });
    expect(approvals).toHaveLength(1);
    await client.approvals.decide((req.payload as { approvalId: never }).approvalId, {
      decision: "approved",
    });
    const all = await collectUntil(client, missionId, (e) => e.type === "mission.completed");
    expect(all.map((e) => e.type)).toContain("approval.decided");
  });

  it("resumes the SSE stream after a stop and start on the same port", async () => {
    const { fake, client } = await boot({ stepDelayMs: 5 });
    const { missionId } = await setup(client, fake, ["a: one", "b: two", "c: three"]);
    await client.missions.start(missionId);
    const ac = new AbortController();
    const seen: string[] = [];
    let restarted = false;
    for await (const e of client.events.stream({
      missionId,
      cursor: fake.cursorAt(0),
      signal: ac.signal,
      backoff: { initialMs: 5, maxMs: 20 },
    })) {
      seen.push(e.id);
      if (!restarted && seen.length === 3) {
        restarted = true;
        await fake.stop();
        await fake.start();
      }
      if (e.type === "mission.completed") break;
    }
    ac.abort();
    const all = fake.events().filter((e) => e.missionId === missionId);
    expect(seen).toEqual(all.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("injects arbitrary protocol-valid events and rejects invalid payloads", async () => {
    const { fake, client } = await boot();
    const { missionId, ids } = await setup(client, fake, ["a: one"]);
    fake.inject(
      "session.output",
      { text: "task completed!", redacted: false, lines: 1 },
      {
        missionId,
        taskId: ids[0]!,
      },
    );
    const { events } = await client.events.replayAll({ missionId, types: ["session.output"] });
    expect(events).toHaveLength(1);
    expect(() => fake.inject("task.completed", { nope: true }, { missionId })).toThrow();
  });

  it("can fail a request once to simulate a crash mid-sequence", async () => {
    const { fake, client } = await boot();
    fake.failNext("POST", "/v1/projects");
    await expect(client.projects.create({ name: "p", repoPath: "/r" })).rejects.toThrow();
    await client.projects.create({ name: "p", repoPath: "/r" });
    expect(fake.creates.projects).toBe(1);
  });
});
