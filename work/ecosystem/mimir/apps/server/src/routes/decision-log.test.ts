import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import {
  CreateMissionResponseSchema,
  CreateProjectResponseSchema,
  DecisionLogBlockResponseSchema,
  newId,
  type DecisionLogBlockRequest,
} from "@mimir/protocol";
import { afterEach, expect, it } from "vitest";
import { MAX_DECISION_LOG_BLOCK_BYTES } from "../decision-log-store.js";
import {
  createTask,
  FAST_TEST_COMMAND,
  harness,
  type Harness,
} from "../orchestrator/test-harness.js";
import { ARTIFACT_COLLECTION_DIR } from "../orchestrator/collect.js";
import { writingRuntime } from "../orchestrator/test-agent-files.js";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../test-helpers.js";

const repos: ReturnType<typeof tempGitRepo>[] = [];
const servers: TestServer[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const s of servers.splice(0)) await s.close();
  for (const repo of repos.splice(0)) repo.cleanup();
});

function repo() {
  const r = tempGitRepo();
  repos.push(r);
  return r;
}

function server(db = ":memory:") {
  const s = makeServer({}, openEventStore(db));
  servers.push(s);
  return s;
}

function post(s: TestServer, url: string, body: object, key = newId("op") as string) {
  return s.app.inject({
    method: "POST",
    url,
    headers: { ...AUTH, "idempotency-key": key },
    payload: body,
  });
}

async function project(s: TestServer, repoPath: string) {
  const res = await post(s, "/v1/projects", { name: "test", repoPath });
  expect(res.statusCode).toBe(201);
  return CreateProjectResponseSchema.parse(res.json()).project.id;
}

const uploadPath = (projectId: string) => `/v1/projects/${projectId}/decision-log-blocks`;

it("pins a long journal without duplicating markdown in missions, snapshots or command receipts; restores it from disk in order", async () => {
  const r = repo();
  const db = join(r.dir, "mimir.db");
  const s = server(db);
  const projectId = await project(s, r.repo);
  const upload = uploadPath(projectId);
  const text = "Decision rationale ".repeat(11500);
  let head: string | null = null;
  const expected = [];
  for (let i = 0; i < 6; i++) {
    const entry = { id: `decision-${i}`, markdown: `${i}: ${text}` };
    expected.push(entry);
    const block: DecisionLogBlockRequest = { previous: head, entries: [entry] };
    const key = `block-${i}`;
    const sent = await post(s, upload, block, key);
    expect(sent.statusCode).toBe(200);
    head = DecisionLogBlockResponseSchema.parse(sent.json()).digest;
    expect(head).toBe(createHash("sha256").update(JSON.stringify(block)).digest("hex"));
    expect(JSON.stringify(s.store.commands.getByKey(key))).not.toContain(text);
    const replay = await post(s, upload, block, key);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.body).toBe(sent.body);
    expect((await post(s, upload, block)).body).toBe(sent.body);
  }
  expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(1024 * 1024);
  const mission = { projectId, objective: "Ship the decision log", decisionLogRef: head! };
  for (let i = 0; i < 3; i++) {
    const res = await post(s, "/v1/missions", mission);
    expect(res.statusCode).toBe(201);
    expect(CreateMissionResponseSchema.parse(res.json()).mission.decisionLogRef).toBe(head);
    expect(res.body.length).toBeLessThan(1024);
  }
  expect(JSON.stringify(s.store.read({ limit: 100 }).events)).not.toContain(text);
  await servers.pop()!.close();
  const restarted = server(db);
  const snap = await restarted.app.inject({ method: "GET", url: "/v1/snapshot", headers: AUTH });
  expect(snap.statusCode).toBe(200);
  expect(snap.body).toContain(head);
  expect(snap.body.length).toBeLessThan(8192);
  expect(restarted.app.mimir.decisionLogs.entries(projectId, head!)).toEqual(expected);
});

it("rejects oversized UTF-8 blocks and unknown or cross-project references before creating missions", async () => {
  const s = server();
  const first = await project(s, repo().repo);
  const second = await project(s, repo().repo);
  const entry = { id: "record", markdown: "chosen option" };
  const block = { previous: null, entries: [entry] };
  const head = DecisionLogBlockResponseSchema.parse(
    (await post(s, uploadPath(first), block, "first")).json(),
  ).digest;
  const bad = await post(s, uploadPath(first), {
    ...block,
    entries: [{ ...entry, markdown: "🐈".repeat(MAX_DECISION_LOG_BLOCK_BYTES / 4) }],
  });
  expect(bad.statusCode).toBe(422);
  expect(bad.body).toContain("256 KiB");
  expect(
    (
      await post(
        s,
        uploadPath(first),
        { ...block, entries: [{ ...entry, markdown: "different" }] },
        "first",
      )
    ).statusCode,
  ).toBe(409);
  expect((await post(s, uploadPath(newId("prj")), block)).statusCode).toBe(404);
  for (const ref of [head, "1".repeat(64)]) {
    expect(
      (await post(s, uploadPath(second), { previous: ref, entries: [entry] })).statusCode,
    ).toBe(404);
    const res = await post(s, "/v1/missions", {
      projectId: second,
      objective: "test",
      decisionLogRef: ref,
    });
    expect(res.statusCode).toBe(404);
  }
  expect(s.store.read({ limit: 100, types: ["mission.created"] }).events).toHaveLength(0);
  expect(
    DecisionLogBlockResponseSchema.parse((await post(s, uploadPath(second), block)).json()).digest,
  ).toBe(head);
});

it("delivers exactly the pinned entries to the finished worktree, joining split markdown across blocks", async () => {
  const h = await harness();
  harnesses.push(h);
  const p = await h.post("/v1/projects", {
    name: "p",
    repoPath: h.repo,
    settings: { testCommand: FAST_TEST_COMMAND },
  });
  const projectId = p.json.project.id as string;
  const upload = uploadPath(projectId);
  const firstPart = "First 📚 " + "漢字".repeat(23_000);
  const secondPart = "🎨".repeat(33_000) + " decision.";
  expect(Buffer.byteLength(firstPart + secondPart)).toBeGreaterThan(MAX_DECISION_LOG_BLOCK_BYTES);
  const first = await h.post(upload, {
    previous: null,
    entries: [{ id: "long", markdown: firstPart }],
  });
  const second = await h.post(upload, {
    previous: first.json.digest,
    entries: [
      { id: "long", markdown: secondPart },
      { id: "next", markdown: "Second decision." },
      { id: "long", markdown: "First 📚 entry repeated." },
      { id: "superseding", markdown: "Supersedes long: choose the replacement." },
    ],
  });
  await h.post(upload, {
    previous: second.json.digest,
    entries: [{ id: "later", markdown: "Later mission only." }],
  });
  const m = await h.post("/v1/missions", {
    projectId,
    objective: "ship",
    decisionLogRef: second.json.digest,
  });
  expect(m.status).toBe(201);
  const missionId = m.json.mission.id as string;
  const c = await h.post("/v1/crews", {
    missionId,
    template: "solo",
    members: [{ role: "implementer", agentKind: "shell" }],
  });
  expect(c.status).toBe(201);
  const taskId = await createTask(h, missionId, "write", "echo ready");
  await h.restart();
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  expect(h.task(taskId).status).toBe("completed");
  const spec = execFileSync("git", ["show", `${h.task(taskId).resultCommit!}:SPEC.md`], {
    cwd: h.repo,
    encoding: "utf8",
  });
  expect(spec).toContain(firstPart + secondPart);
  expect(spec.indexOf(firstPart)).toBeLessThan(spec.indexOf("Second decision."));
  expect(spec.match(/First 📚/g)).toHaveLength(1);
  expect(spec).toContain("Supersedes long: choose the replacement.");
  expect(spec).not.toContain("Later mission");
}, 120_000);

it("detects corrupt or missing ancestors even when they were previously read", async () => {
  const s = server();
  const p = await project(s, repo().repo);
  const logs = s.app.mimir.decisionLogs;
  const first = logs.put(p, { previous: null, entries: [{ id: "one", markdown: "one" }] });
  const head = logs.put(p, { previous: first, entries: [{ id: "two", markdown: "two" }] });
  expect(logs.entries(p, head)).toHaveLength(2);
  const db = s.store.connection();
  db.prepare(
    "UPDATE project_decision_log_blocks SET body = '{}' WHERE project_id = ? AND digest = ?",
  ).run(p, first);
  expect(() => logs.entries(p, head)).toThrow(/corrupt/);
  db.prepare("DELETE FROM project_decision_log_blocks WHERE project_id = ? AND digest = ?").run(
    p,
    first,
  );
  expect(() => logs.entries(p, head)).toThrow(/missing/);
});

it.each([false, true])(
  "waits across restart for one verification-time pin and releases concurrent verifiers (empty=%s)",
  async (empty) => {
    const h = await harness();
    harnesses.push(h);
    const created = await h.post("/v1/projects", {
      name: "p",
      repoPath: h.repo,
      settings: { testCommand: FAST_TEST_COMMAND },
    });
    const projectId = created.json.project.id as string;
    const m = await h.post("/v1/missions", {
      projectId,
      objective: "ship",
      decisionLogAtVerification: true,
    });
    expect(m.status).toBe(201);
    const missionId = m.json.mission.id as string;
    const pin = `/v1/missions/${missionId}/decision-log`;
    expect((await h.post(pin, { decisionLogRef: null })).status).toBe(409);
    const c = await h.post("/v1/crews", {
      missionId,
      template: "solo",
      limits: { maxConcurrentTasks: 2 },
      members: [
        { role: "implementer", agentKind: "shell" },
        { role: "implementer", agentKind: "shell" },
      ],
    });
    expect(c.status).toBe(201);
    const a = await createTask(h, missionId, "One", "echo one");
    const b = await createTask(h, missionId, "Two", "echo two");
    await h.post(`/v1/missions/${missionId}/start`);
    await h.tick();
    expect(h.events(["mission.decision_log_requested"])).toHaveLength(0);
    await h.advance(1000);
    expect([h.task(a).status, h.task(b).status]).toEqual(["verifying", "verifying"]);
    const requests = h.events(["mission.decision_log_requested"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ missionId, payload: {} });
    expect(h.events(["test.run_completed"])).toHaveLength(0);
    await h.restart();
    await h.idle();
    expect(h.events(["mission.decision_log_requested"])).toEqual(requests);
    expect((await h.get(`/v1/missions/${missionId}`)).json.mission).toMatchObject({
      decisionLogAtVerification: true,
      decisionLogRequested: true,
    });
    const wrongProject = await h.post("/v1/projects", { name: "other", repoPath: repo().repo });
    const foreign = await h.post(uploadPath(wrongProject.json.project.id), {
      previous: null,
      entries: [{ id: "foreign", markdown: "foreign decision" }],
    });
    expect((await h.post(pin, { decisionLogRef: foreign.json.digest })).status).toBe(404);
    const later = await h.post(uploadPath(projectId), {
      previous: null,
      entries: [{ id: "accepted", markdown: "Accepted during implementation." }],
    });
    const ref = empty ? null : (later.json.digest as string);
    const ack = await h.post(pin, { decisionLogRef: ref });
    expect(ack.status).toBe(200);
    expect(ack.json.mission).toMatchObject({ decisionLogPinned: true });
    expect(ack.json.mission.decisionLogRef ?? null).toBe(ref);
    expect((await h.post(pin, { decisionLogRef: ref })).status).toBe(200);
    expect((await h.post(pin, { decisionLogRef: empty ? later.json.digest : null })).status).toBe(
      409,
    );
    await h.idle();
    expect([h.task(a).status, h.task(b).status]).toEqual(["completed", "completed"]);
    expect(h.events(["mission.decision_log_pinned"])).toHaveLength(1);
    expect(h.events(["test.run_completed"])).toHaveLength(2);
    for (const taskId of [a, b]) {
      const commit = h.task(taskId).resultCommit!;
      const files = execFileSync("git", ["ls-tree", "-r", "--name-only", commit], {
        cwd: h.repo,
        encoding: "utf8",
      }).split("\n");
      expect(files.includes("SPEC.md")).toBe(!empty);
      if (!empty) {
        const spec = execFileSync("git", ["show", `${commit}:SPEC.md`], {
          cwd: h.repo,
          encoding: "utf8",
        });
        expect(spec).toContain("Accepted during implementation.");
      }
    }
  },
  120_000,
);

it("leaves a document-only mission free to complete without requesting a decision log", async () => {
  const h = await harness({
    wrapRuntime: (fake) =>
      writingRuntime(fake, (cwd) => {
        const dir = join(cwd, ARTIFACT_COLLECTION_DIR);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "research.md"), "# Findings\n");
      }),
  });
  harnesses.push(h);
  const p = await h.post("/v1/projects", { name: "p", repoPath: h.repo });
  const m = await h.post("/v1/missions", {
    projectId: p.json.project.id,
    objective: "research",
    decisionLogAtVerification: true,
  });
  const missionId = m.json.mission.id as string;
  await h.post("/v1/crews", {
    missionId,
    template: "solo",
    members: [{ role: "implementer", agentKind: "shell" }],
  });
  const task = await h.post("/v1/tasks", {
    missionId,
    title: "Read",
    brief: "echo read",
    mode: { deliverable: "document", access: "read" },
  });
  await h.post(`/v1/missions/${missionId}/start`);
  await h.tick();
  await h.advance(1000);
  expect(h.task(task.json.task.id).status).toBe("completed");
  expect(h.events(["mission.decision_log_requested"])).toHaveLength(0);
}, 120_000);
