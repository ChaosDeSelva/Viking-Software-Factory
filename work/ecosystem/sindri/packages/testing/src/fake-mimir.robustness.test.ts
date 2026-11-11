import { connect } from "node:net";
import { newId, type TaskId } from "@mimir/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeMimir, type FakeMimir } from "./fake-mimir.js";

let fake: FakeMimir | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const auth = (f: FakeMimir) => ({ authorization: `Bearer ${f.token}` });
let keys = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw response JSON, read freely in assertions
type Body = Record<string, any>;
async function post(f: FakeMimir, path: string, body: unknown, key = `rk-${++keys}`) {
  const res = await fetch(f.url + path, {
    method: "POST",
    headers: { ...auth(f), "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}
async function get(f: FakeMimir, path: string) {
  const res = await fetch(f.url + path, { headers: auth(f) });
  return { status: res.status, body: (await res.json()) as Body };
}
async function projectAndMission(f: FakeMimir) {
  const project = (await post(f, "/v1/projects", { name: "p", repoPath: "/tmp/p" })).body.project;
  const mission = (await post(f, "/v1/missions", { projectId: project.id, objective: "o" })).body
    .mission;
  return { projectId: project.id as string, missionId: mission.id as string };
}

describe("createFakeMimir robustness", () => {
  it("answers a path with a malformed percent-escape instead of leaving the request hanging", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    const res = await fetch(`${fake.url}/v1/missions/%E0%A4%A`, {
      headers: auth(fake),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "validation_failed",
    );
  });

  it("answers 404 for a request target that is not a path the fake serves ('//')", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    const res = await fetch(`${fake.url}//`, {
      headers: auth(fake),
      signal: AbortSignal.timeout(5000),
    });
    expect(res.status).toBe(404);
  });

  it("survives a client that disconnects in the middle of a request body", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    const port = Number(new URL(fake.url).port);
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            "POST /v1/projects HTTP/1.1\r\nhost: fake\r\ncontent-type: application/json\r\n" +
              'content-length: 500\r\n\r\n{"name":',
            () => socket.destroy(),
          );
        });
        socket.on("close", () => resolve());
        socket.on("error", reject);
      });
      // Round-trips give the server time to observe the aborted request.
      for (let i = 0; i < 3; i++) {
        expect((await fetch(`${fake.url}/v1/health`)).status).toBe(200);
      }
      await new Promise((r) => setImmediate(r));
      expect(rejections).toEqual([]);
      expect(fake.creates.projects).toBe(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("start() while already listening fails and leaves the running server under the fake's control", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    await expect(fake.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect((await fetch(`${fake.url}/v1/health`)).status).toBe(200);
    await fake.stop();
    await expect(fetch(`${fake.url}/v1/health`)).rejects.toThrow();
    // stop() is idempotent, and the port can be taken again afterwards.
    await fake.stop();
    await fake.start();
    expect((await fetch(`${fake.url}/v1/health`)).status).toBe(200);
  });

  it("rejects a second task with a client-chosen id that already exists (409), keeping the first", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    const { missionId } = await projectAndMission(fake);
    const id = newId("tsk") as TaskId;
    const first = await post(fake, "/v1/tasks", { id, missionId, title: "first", brief: "b" });
    expect(first.status).toBe(201);
    const second = await post(fake, "/v1/tasks", { id, missionId, title: "second", brief: "b" });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("conflict");
    expect(fake.creates.tasks).toBe(1);
    expect(fake.tasks().map((t) => t.title)).toEqual(["first"]);
  });

  it("creates nothing when one task of POST /v1/missions { tasks } is invalid", async () => {
    fake = await createFakeMimir({ stepDelayMs: 0 });
    const { projectId } = await projectAndMission(fake);
    const before = { creates: { ...fake.creates }, events: fake.events().length };
    const a = newId("tsk") as TaskId;
    const unknownDep = await post(fake, "/v1/missions", {
      projectId,
      objective: "broken",
      tasks: [
        { id: a, title: "a", brief: "b" },
        { title: "b", brief: "b", dependsOn: [newId("tsk")] },
      ],
    });
    expect(unknownDep.status).toBe(404);
    const duplicateIds = await post(fake, "/v1/missions", {
      projectId,
      objective: "broken",
      tasks: [
        { id: a, title: "a", brief: "b" },
        { id: a, title: "a again", brief: "b" },
      ],
    });
    expect(duplicateIds.status).toBe(409);
    expect(fake.creates).toEqual(before.creates);
    expect(fake.events()).toHaveLength(before.events);
    expect((await get(fake, "/v1/missions")).body.missions).toHaveLength(1);
    expect(fake.tasks()).toEqual([]);
  });
});
