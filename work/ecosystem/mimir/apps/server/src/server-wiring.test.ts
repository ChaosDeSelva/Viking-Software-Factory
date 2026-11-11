import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openEventStore } from "@mimir/core";
import { FakeRuntime } from "@mimir/fake-runtime";
import { newId } from "@mimir/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./index.js";
import { SupervisorStore, type Message } from "./supervision/store.js";
import { AUTH, TOKEN, eventInput, makeServer, type TestServer } from "./test-helpers.js";

const servers: TestServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};

async function until<T>(read: () => T | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("buildServer options", () => {
  it("refuses an empty auth token", () => {
    const store = openEventStore(":memory:");
    expect(() =>
      buildServer({
        store,
        ledger: store.commands,
        audit: store.audit,
        runtime: null,
        authToken: "",
      }),
    ).toThrow(/authToken must not be empty/);
    store.close();
  });

  it("without a data dir it keeps artifacts in a fresh temp dir; the default tick loop stops on close", async () => {
    const store = openEventStore(":memory:");
    const app = buildServer({
      store,
      ledger: store.commands,
      audit: store.audit,
      runtime: new FakeRuntime(),
      authToken: TOKEN,
      publicOrigins: ["http://localhost:80"],
    });
    const dataDir = dirname(app.mimir.artifacts.dir);
    dirs.push(dataDir, `${dataDir}-worktrees`);
    expect(dataDir.startsWith(realpathSync(tmpdir())) || dataDir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    expect((await app.inject({ url: "/v1/projects", headers: AUTH })).statusCode).toBe(200);
    await app.close();
    store.close();
  });

  it("without configured public origins only the bound loopback names are accepted", async () => {
    const store = openEventStore(":memory:");
    const dataDir = tempDir("mimir-wiring-origins-");
    dirs.push(`${dataDir}-worktrees`);
    const app = buildServer({
      store,
      ledger: store.commands,
      audit: store.audit,
      runtime: null,
      authToken: TOKEN,
      dataDir,
      tickMs: 0,
    });
    try {
      // Not listening yet: no origin is this server's own, so every Host is refused.
      expect((await app.inject({ url: "/v1/health" })).statusCode).toBe(403);
      await app.listen({ host: "127.0.0.1", port: 0 });
      const { port } = app.server.address() as { port: number };
      const own = await app.inject({ url: "/v1/health", headers: { host: `localhost:${port}` } });
      expect(own.statusCode).toBe(200);
      const other = await app.inject({ url: "/v1/health", headers: { host: "localhost:80" } });
      expect(other.statusCode).toBe(403);
    } finally {
      await app.close();
      store.close();
    }
  });

  it("prunes artifacts older than the retention at boot", async () => {
    const dataDir = tempDir("mimir-wiring-data-");
    dirs.push(`${dataDir}-worktrees`);
    const artifacts = join(dataDir, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    const old = join(artifacts, newId("art"));
    const fresh = join(artifacts, newId("art"));
    writeFileSync(old, "old");
    writeFileSync(fresh, "fresh");
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000);
    utimesSync(old, tenDaysAgo, tenDaysAgo);
    const s = makeServer({ dataDir, artifactRetentionDays: 2 });
    servers.push(s);
    await s.app.ready();
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe("HTTPS", () => {
  const hasOpenssl = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasOpenssl)(
    "serves TLS on loopback and checks Host/Origin against https origins",
    async () => {
      const dir = tempDir("mimir-tls-");
      const key = join(dir, "key.pem");
      const cert = join(dir, "cert.pem");
      execFileSync(
        "openssl",
        ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert].concat([
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
        ]),
        { stdio: "ignore" },
      );
      const s = makeServer({
        https: { cert: readFileSync(cert), key: readFileSync(key) },
        publicOrigins: [],
      });
      servers.push(s);
      await s.app.listen({ host: "127.0.0.1", port: 0 });
      const { port } = s.app.server.address() as { port: number };
      const get = (path: string, headers: Record<string, string> = {}) =>
        new Promise<number>((resolve, reject) => {
          const req = httpsRequest(
            { host: "127.0.0.1", port, path, headers, rejectUnauthorized: false },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", reject);
          req.end();
        });
      expect(await get("/v1/health")).toBe(200);
      expect(await get("/v1/projects", AUTH)).toBe(200);
      expect(await get("/v1/projects", { ...AUTH, origin: `https://127.0.0.1:${port}` })).toBe(200);
      // The plain-http spelling of the same host is another origin.
      expect(await get("/v1/projects", { ...AUTH, origin: `http://127.0.0.1:${port}` })).toBe(403);
    },
    30_000,
  );
});

describe("supervisor control wiring", () => {
  /** A server whose supervisor engine is running, and a second handle on its supervisor db. */
  async function setup() {
    const fake = new FakeRuntime();
    const s = makeServer({ runtime: fake });
    servers.push(s);
    const dataDir = dirname(s.app.mimir.artifacts.dir);
    await s.app.ready(); // starts the engine (1 s tick)
    const sup = new SupervisorStore(join(dataDir, "supervisors.sqlite"));
    const post = (url: string, payload: Record<string, unknown>) =>
      s.app.inject({
        method: "POST",
        url,
        headers: { ...AUTH, "idempotency-key": randomUUID() },
        payload,
      });
    expect((await post("/v1/supervisors", { id: "sup" })).statusCode).toBe(201);
    const sessionId = newId("ses");
    const taskId = newId("tsk");
    const crewId = newId("crw");
    s.store.append(
      eventInput({
        type: "session.requested",
        streamId: `session:${sessionId}`,
        sessionId,
        taskId,
        payload: { agentKind: "shell", crewId, taskId, workspaceLabel: "w" },
      }),
    );
    await fake.createSession({
      sessionId,
      idempotencyKey: sessionId,
      crewId,
      taskId,
      agentKind: "shell",
      argv: ["true"],
      cwd: dataDir,
      env: {},
      workspaceLabel: "w",
    } as Parameters<FakeRuntime["createSession"]>[0]);
    const settled = (id: string) =>
      until<Message>(() =>
        sup
          .messages("sup")
          .find((m) => m.id === id && m.state !== "pending" && m.state !== "dispatching"),
      );
    return { s, sup, post, sessionId, taskId, fake, settled, dataDir };
  }

  it("runs operator observe, input and stop controls through the runtime and orchestrator", async () => {
    const { sup, post, sessionId, fake, settled } = await setup();
    try {
      const control = (id: string, c: Record<string, unknown>) =>
        post("/v1/supervisors/sup/messages", { id, control: { sessionId, ...c } });
      expect((await control("obs", { kind: "observe" })).statusCode).toBe(202);
      const observed = await settled("obs");
      expect(observed.state).toBe("done");
      expect(JSON.parse(observed.result as string)).toMatchObject({ sessionId });

      expect((await control("in", { kind: "input", text: "hello" })).statusCode).toBe(202);
      expect(await settled("in")).toMatchObject({ state: "done", result: "Instruction delivered" });
      expect(await fake.readTerminal(sessionId)).toContain("hello");

      expect((await control("stop", { kind: "stop", mode: "soft" })).statusCode).toBe(202);
      const stopped = await settled("stop");
      expect(stopped.state).toBe("done");
      expect(JSON.parse(stopped.result as string)).toEqual({ kind: "done" });
    } finally {
      sup.close();
    }
  }, 60_000);

  it("observing a session the runtime no longer has reports state unknown", async () => {
    const { sup, post, sessionId, fake, settled } = await setup();
    try {
      fake.loseSession(sessionId);
      await post("/v1/supervisors/sup/messages", {
        id: "obs-lost",
        control: { kind: "observe", sessionId },
      });
      const observed = await settled("obs-lost");
      expect(observed.state).toBe("done");
      expect(JSON.parse(observed.result as string)).toEqual({ state: "unknown" });
    } finally {
      sup.close();
    }
  }, 60_000);

  it("an unknown control kind and a think without policy never reach a runtime or a model", async () => {
    const { sup, sessionId, settled } = await setup();
    try {
      sup.enqueue("bogus", "sup", "format-disk", { sessionId, text: "x", mode: "soft" });
      expect(await settled("bogus")).toMatchObject({ state: "uncertain" });
      sup.enqueue("think-1", "sup", "think", { missionId: newId("msn"), reason: "check" });
      expect(await settled("think-1")).toMatchObject({
        state: "done",
        result: "Supervisor policy disabled or superseded; no model called",
      });
    } finally {
      sup.close();
    }
  }, 60_000);

  it("an enabled policy whose mission is gone fails its thought without calling a model", async () => {
    const { sup, settled, dataDir } = await setup();
    try {
      sup.configure("sup", {
        missionId: newId("msn"),
        agentKind: "codex",
        enabled: true,
        intervalMs: 30_000,
        maxTurns: 1,
      });
      // The engine queues the periodic thought itself; the mission lookup fails before any model.
      const thought = await settled("think:sup:1");
      expect(thought.state).toBe("uncertain");
      expect(sup.policy("sup")?.turns).toBe(1);
      // CliThinker creates this directory before it launches a model CLI.
      expect(existsSync(join(dataDir, "supervisor-decisions"))).toBe(false);
    } finally {
      sup.close();
    }
  }, 60_000);

  it("thinks about an existing mission with its tasks and sessions as context", async () => {
    const { s, sup, settled, sessionId, taskId } = await setup();
    // A stub model CLI (never a real one): it logs its prompt and answers with a decision.
    const bin = tempDir("supervisor-model-");
    const promptLog = join(bin, "prompt.txt");
    const codex = join(bin, "codex");
    writeFileSync(
      codex,
      `#!/bin/sh\nfor a; do last="$a"; done\nprintf '%s' "$last" > '${promptLog}'\necho '{"report":"healthy","actions":[{"kind":"observe","sessionId":"${sessionId}"}]}'\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("MIMIR_CODEX_BIN", codex);
    try {
      const missionId = newId("msn");
      s.store.append(eventInput({ streamId: `mission:${missionId}`, missionId }));
      s.store.append(
        eventInput({
          type: "task.created",
          streamId: `task:${taskId}`,
          missionId,
          taskId,
          payload: { missionId, crewId: null, title: "t", acceptance: "a", dependsOn: [] },
        }),
      );
      // A session of a task outside the mission is out of the supervisor's scope.
      const otherSession = newId("ses");
      const otherTask = newId("tsk");
      s.store.append(
        eventInput({
          type: "session.requested",
          streamId: `session:${otherSession}`,
          sessionId: otherSession,
          taskId: otherTask,
          payload: {
            agentKind: "shell",
            crewId: newId("crw"),
            taskId: otherTask,
            workspaceLabel: "w",
          },
        }),
      );
      sup.configure("sup", {
        missionId,
        agentKind: "codex",
        enabled: true,
        intervalMs: 30_000,
        maxTurns: 1,
      });
      const thought = await settled("think:sup:1");
      expect(thought.state).toBe("done");
      expect(JSON.parse(thought.result as string)).toEqual({
        report: "healthy",
        actions: [{ kind: "observe", sessionId }],
      });
      const prompt = readFileSync(promptLog, "utf8");
      const context = JSON.parse(
        prompt.slice(prompt.indexOf("Context: ") + 9, prompt.indexOf("\nPrevious supervisor")),
      ) as { mission: { id: string }; tasks: { id: string }[]; sessionIds: string[] };
      expect(context.mission.id).toBe(missionId);
      expect(context.tasks.map((t) => t.id)).toEqual([taskId]);
      expect(context.sessionIds).toEqual([sessionId]);
      expect(await settled("think:sup:1:action:0")).toMatchObject({ state: "done" });
    } finally {
      vi.unstubAllEnvs();
      sup.close();
    }
  }, 120_000);
});
