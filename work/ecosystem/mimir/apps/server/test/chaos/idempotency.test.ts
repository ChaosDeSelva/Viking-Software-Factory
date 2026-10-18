import { afterEach, describe, expect, it } from "vitest";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

let server: TestServer | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const fn of cleanups.splice(0)) fn();
});

async function listen(): Promise<string> {
  server = makeServer();
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = server.app.server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

const post = (base: string, key: string, repoPath: string) =>
  fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { ...AUTH, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ name: "same", repoPath }),
  });

describe("chaos: concurrent idempotent creates", () => {
  it("10 parallel identical POST /v1/projects with one key create exactly one project", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    const base = await listen();
    const results = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const res = await post(base, "same-key", repo.repo);
        const body = (await res.json()) as { project?: { id: string }; error?: { code: string } };
        return { status: res.status, replayed: res.headers.get("idempotency-replayed"), body };
      }),
    );
    const created = results.filter((r) => r.status === 201 && r.replayed === null);
    expect(created).toHaveLength(1);
    const id = created[0]?.body.project?.id;
    for (const r of results) {
      // Others either replay the stored reply or see the command still in flight (409).
      if (r.status === 201) expect(r.body.project?.id).toBe(id);
      else expect(r).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
    }
    const list = await fetch(`${base}/v1/projects`, { headers: AUTH });
    expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);
    // A late retry with the same key replays the one result.
    const late = await post(base, "same-key", repo.repo);
    expect(late.status).toBe(201);
    expect(late.headers.get("idempotency-replayed")).toBe("true");
    expect(((await late.json()) as { project: { id: string } }).project.id).toBe(id);
  });

  it("10 parallel creates for one repo under different keys still yield one project", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    const base = await listen();
    const statuses = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => (await post(base, `key-${i}`, repo.repo)).status),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    const list = await fetch(`${base}/v1/projects`, { headers: AUTH });
    expect(((await list.json()) as { projects: unknown[] }).projects).toHaveLength(1);
  });
});
