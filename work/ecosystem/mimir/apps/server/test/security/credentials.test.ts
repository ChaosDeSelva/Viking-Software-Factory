import { Writable } from "node:stream";
import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { newId } from "@mimir/protocol";
import {
  CREDENTIAL_SAMPLES,
  findSecretsInFiles,
  openSse,
  recordRuntime,
  secretCores,
  withFakeRuntime,
} from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../../src/logger.js";
import { AUTH, makeServer, tempGitRepo, type TestServer } from "../../src/test-helpers.js";

const [SK, GHP, AWS, JWT, BEARER, PASSWORD] = CREDENTIAL_SAMPLES as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const CORES = secretCores();

/** Session output an agent might print while working. */
const LEAKY_OUTPUT = [
  `export OPENAI_API_KEY=${SK}`,
  `remote: https://x-access-token:${GHP}@example.invalid/repo.git`,
  `aws_access_key_id = ${AWS}`,
  `{"id_token": "${JWT}"}`,
  `curl -H "Authorization: ${BEARER}" https://api.example.invalid`,
  `DB ${PASSWORD}`,
];

let server: TestServer | undefined;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await server?.close();
  server = undefined;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

describe("security: credential-like strings never reach GET /v1/events or disk", () => {
  it("session output, project fields and rejected request bodies are redacted everywhere", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    const dataDir = join(repo.dir, "data");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir);
    let logs = "";
    const logger = createLogger({
      level: "debug",
      stream: new Writable({
        write(chunk: Buffer, _enc, cb) {
          logs += chunk.toString("utf8");
          cb();
        },
      }),
    });
    const store = openEventStore(join(dataDir, "mimir.db"));
    const { fake, clock } = withFakeRuntime(
      LEAKY_OUTPUT.map((output, i) => ({ afterMs: 10 * (i + 1), output })),
    );
    server = makeServer({ runtime: fake, logger }, store);
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;

    // 1. An agent prints secrets; the runtime events are recorded into the log.
    const rec = await recordRuntime(fake, store);
    await fake.createSession({
      sessionId: newId("ses"),
      idempotencyKey: "s1",
      crewId: newId("crw"),
      taskId: newId("tsk"),
      agentKind: "shell",
      argv: ["sh"],
      cwd: repo.repo,
      env: {},
      workspaceLabel: "w",
    });
    clock.advance(100);
    rec.close();

    // 2. An operator puts secrets in a project's name and settings.
    const created = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "p1" },
      body: JSON.stringify({
        name: `deploy ${SK}`,
        repoPath: repo.repo,
        settings: { apiToken: GHP, notes: `aws ${AWS}`, nested: { auth: BEARER } },
      }),
    });
    // Refused (not rewritten): 422 naming every offending field, and no value echoed back.
    expect(created.status).toBe(422);
    const refusal = await created.text();
    expect(JSON.parse(refusal)).toMatchObject({
      error: {
        code: "validation_failed",
        details: {
          reason: "credential_in_project_field",
          fields: expect.arrayContaining([
            { field: "name", kind: "api_key" },
            { field: "settings.apiToken", kind: "github_token" },
            { field: "settings.notes", kind: "aws_key" },
            { field: "settings.nested.auth", kind: "bearer" },
          ]),
        },
      },
    });
    for (const core of CORES) expect(refusal).not.toContain(core);
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);

    // 3. A rejected request carrying secrets (stored in the command ledger as the request).
    const rejected = await fetch(`${base}/v1/projects`, {
      method: "POST",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "p2" },
      body: JSON.stringify({ name: JWT, repoPath: `/nope/${PASSWORD}` }),
    });
    expect(rejected.status).toBe(422);

    // GET /v1/events: the outputs are there, the secrets are not.
    const events = await fetch(`${base}/v1/events?limit=1000`, { headers: AUTH });
    const text = await events.text();
    expect((JSON.parse(text) as { events: unknown[] }).events.length).toBeGreaterThanOrEqual(
      LEAKY_OUTPUT.length,
    );
    for (const core of CORES) expect(text).not.toContain(core);
    expect(text).toContain("REDACTED");

    // SSE replay of the same log.
    const sse = await openSse(`${base}/v1/events/stream?cursor=MA==`, AUTH);
    cleanups.push(() => sse.close());
    while (sse.messages.filter((m) => m.data !== undefined).length < LEAKY_OUTPUT.length) {
      await sse.next(5000);
    }
    for (const core of CORES) expect(sse.text()).not.toContain(core);

    // Nothing on disk (db, WAL, shm) while the server runs, nor after it closes and checkpoints.
    expect(findSecretsInFiles(dataDir, CORES)).toEqual([]);
    sse.close();
    await server.close();
    server = undefined;
    expect(findSecretsInFiles(dataDir, CORES)).toEqual([]);
    for (const core of CORES) expect(logs).not.toContain(core);
  });
});

describe("security: project fields are validated, never rewritten (T14a fix I2)", () => {
  // The event store redacts every payload before insert (defence in depth, ruling on the T14afix
  // merge), so the byte-for-byte guarantee covers inputs the redactor leaves unchanged. Redactor
  // false positives on "Deploy Bearer Service" and "sk-learn-..." are tracked for the Msec lane.
  it("legitimate settings and name round-trip byte for byte", async () => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    server = makeServer({ runtime: null });
    const settings = {
      maxTokens: 4096,
      model: "claude-sonnet-5-5",
      region: "us-east-1",
      limits: { daily: 100000 },
      labels: ["ci", "deploy"],
    };
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "legit" },
      payload: { name: "Deploy Service", repoPath: repo.repo, settings },
    });
    expect(res.statusCode).toBe(201);
    const project = (res.json() as { project: { name: string; settings: unknown } }).project;
    expect(project.name).toBe("Deploy Service");
    expect(project.settings).toEqual(settings);
    const listed = await server.app.inject({ url: "/v1/projects", headers: AUTH });
    expect(JSON.stringify((listed.json() as { projects: unknown[] }).projects[0])).toContain(
      JSON.stringify(settings),
    );
  });

  it.each([
    ["name", { name: `prod ${JWT}` }, "name", "jwt"],
    ["a settings key", { settings: { [GHP]: "x" } }, "settings", "github_token"],
    ["an array element", { settings: { keys: ["ok", AWS] } }, "settings.keys[1]", "aws_key"],
    [
      "a private key block",
      { settings: { pem: "-----BEGIN PRIVATE KEY-----\nMII\n-----END PRIVATE KEY-----" } },
      "settings.pem",
      "private_key",
    ],
    [
      "a URL with userinfo",
      { settings: { remote: "https://user:pass@host" } },
      "settings.remote",
      "url_userinfo",
    ],
  ])("a credential in %s → 422 naming the field", async (_label, over, field, kind) => {
    const repo = tempGitRepo();
    cleanups.push(repo.cleanup);
    server = makeServer({ runtime: null });
    const res = await server.app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { ...AUTH, "content-type": "application/json", "idempotency-key": "bad" },
      payload: { name: "p", repoPath: repo.repo, ...over },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      error: {
        code: "validation_failed",
        details: { reason: "credential_in_project_field", fields: [{ field, kind }] },
      },
    });
    expect(server.app.mimir.readModel.snapshot().projects).toEqual([]);
  });
});
