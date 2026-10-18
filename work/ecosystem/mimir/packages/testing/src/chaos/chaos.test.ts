import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type EventEnvelope } from "@mimir/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFakeRuntime } from "../index.js";
import {
  CHAOS_TOKEN,
  CREDENTIAL_SAMPLES,
  findSecretsInFiles,
  injectCorruptEventRow,
  recordRuntime,
  runMimirToExit,
  spawnMimir,
  type AppendLike,
  type SqlDb,
} from "./index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mimir-chaos-helper-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in for main.ts: prints the ready line, then idles (or fails as scripted). */
function stubEntry(body: string): string {
  const path = join(dir, `stub-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, body);
  return path;
}

const READY_STUB = `console.log("mimir server listening on http://127.0.0.1:4321");
console.log("env-token " + (process.env.MIMIR_AUTH_TOKEN ?? "") + " port " + process.env.MIMIR_PORT);
setInterval(() => {}, 1000);`;

describe("spawnMimir", () => {
  it("resolves with the URL from the ready line and passes a clean MIMIR_* env", async () => {
    const p = await spawnMimir({ entry: stubEntry(READY_STUB), dataDir: dir });
    try {
      expect(p.url).toBe("http://127.0.0.1:4321");
      expect(p.token).toBe(CHAOS_TOKEN);
      await p.waitForLine(/env-token/);
      expect(p.output()).toContain(`env-token ${CHAOS_TOKEN} port 0`);
    } finally {
      const exit = await p.kill("SIGKILL");
      expect(exit.signal).toBe("SIGKILL");
    }
  });

  it("rejects with the process output when it exits before it is ready", async () => {
    const entry = stubEntry(`console.error("boom: refused"); process.exit(3);`);
    await expect(spawnMimir({ entry, dataDir: dir })).rejects.toThrow(/exited.*3[\s\S]*boom/);
  });

  it("runMimirToExit returns the exit code and output", async () => {
    const entry = stubEntry(`console.error("nope"); process.exit(2);`);
    const r = await runMimirToExit({ entry, dataDir: dir });
    expect(r.code).toBe(2);
    expect(r.output).toContain("nope");
  });
});

describe("findSecretsInFiles", () => {
  it("reports every sample found in any file under a directory, by raw bytes", () => {
    const sample = CREDENTIAL_SAMPLES[0] as string;
    writeFileSync(
      join(dir, "a.db-wal"),
      Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(sample)]),
    );
    writeFileSync(join(dir, "b.db"), "clean");
    expect(findSecretsInFiles(dir, CREDENTIAL_SAMPLES)).toEqual([
      { file: join(dir, "a.db-wal"), secret: sample },
    ]);
  });

  it("returns nothing for clean files", () => {
    writeFileSync(join(dir, "b.db"), "clean");
    expect(findSecretsInFiles(dir, CREDENTIAL_SAMPLES)).toEqual([]);
  });
});

describe("injectCorruptEventRow", () => {
  it("bumps global_seq and the stream counter and inserts a truncated payload", () => {
    const calls: { sql: string; args: unknown[] }[] = [];
    const db: SqlDb = {
      prepare: (sql) => ({
        get: (...args) => {
          calls.push({ sql, args });
          return sql.includes("counters") ? { value: 7 } : { last_sequence: 2 };
        },
        run: (...args) => {
          calls.push({ sql, args });
          return {};
        },
      }),
      transaction: (fn) => () => fn(),
    };
    const out = injectCorruptEventRow(db, { streamId: "s1" });
    expect(out).toMatchObject({ globalSeq: 7, sequence: 2 });
    const insert = calls.find((c) => c.sql.startsWith("INSERT INTO events"));
    expect(insert?.args).toContain("s1");
    const payload = insert?.args.at(-1) as string;
    expect(() => JSON.parse(payload) as unknown).toThrow();
  });
});

describe("recordRuntime", () => {
  /** In-memory appender with the store's (source, sourceEventId) dedupe. */
  function memoryAppender() {
    const events: AppendLike[] = [];
    const seen = new Set<string>();
    return {
      events,
      append(input: AppendLike): unknown {
        if (input.sourceEventId !== undefined) {
          const key = `${input.source}\u0000${input.sourceEventId}`;
          if (seen.has(key)) return undefined;
          seen.add(key);
        }
        events.push(input);
        return undefined;
      },
    };
  }

  const spec = (sessionId: string) => ({
    sessionId,
    idempotencyKey: sessionId,
    crewId: newId("crw"),
    taskId: newId("tsk"),
    agentKind: "shell",
    argv: ["true"],
    cwd: "/tmp",
    env: {},
    workspaceLabel: "w",
  });

  it("records session events and turns a runtime.gap into recovery.reconciled{gap:true}", async () => {
    const { fake, clock } = withFakeRuntime();
    const app = memoryAppender();
    const rec = await recordRuntime(fake, app);
    const sid = newId("ses");
    await fake.createSession(spec(sid));
    clock.advance(150);
    fake.chaos({ dropNextEvents: 1 });
    clock.advance(400); // idle transition dropped
    fake.chaos({ emitGap: true });
    await rec.idle();
    rec.close();
    const types = app.events.map((e) => e.type);
    expect(types).toContain("recovery.reconciled");
    const gap = app.events.find((e) => e.type === "recovery.reconciled");
    expect(gap?.payload).toMatchObject({ gap: true, sessions: 1, lostSessionIds: [] });
    const states = app.events
      .filter((e) => e.type === "session.state_changed")
      .map((e) => (e.payload as { to: string }).to);
    expect(states).toEqual(["running", "idle"]);
    expect(rec.gaps).toBe(1);
  });

  it("a second reconcile (or a restarted recorder) appends no duplicate session events", async () => {
    const { fake, clock } = withFakeRuntime();
    const app = memoryAppender();
    const sid = newId("ses");
    const r1 = await recordRuntime(fake, app);
    await fake.createSession(spec(sid));
    clock.advance(150);
    fake.loseSession(sid);
    fake.chaos({ emitGap: true });
    await r1.idle();
    r1.close();
    const before = app.events.filter((e) => e.type.startsWith("session.")).length;
    const r2 = await recordRuntime(fake, app);
    fake.chaos({ emitGap: true });
    await r2.idle();
    r2.close();
    const sessionEvents = app.events.filter((e) => e.type.startsWith("session."));
    expect(sessionEvents).toHaveLength(before);
    expect(sessionEvents.filter((e) => e.type === "session.lost")).toHaveLength(1);
    const reconciled = app.events.filter((e) => e.type === "recovery.reconciled");
    expect(reconciled.map((e) => e.payload)).toEqual([
      { sessions: 0, lostSessionIds: [sid], gap: true },
      { sessions: 0, lostSessionIds: [sid], gap: true },
    ]);
  });

  it("envelope inputs carry the session id, stream and observed provenance", async () => {
    const { fake, clock } = withFakeRuntime();
    const app = memoryAppender();
    const rec = await recordRuntime(fake, app, { source: "runtime:test" });
    const sid = newId("ses");
    await fake.createSession(spec(sid));
    clock.advance(150);
    rec.close();
    const e = app.events[0] as Omit<EventEnvelope, "id" | "sequence" | "schemaVersion">;
    expect(e).toMatchObject({
      type: "session.state_changed",
      sessionId: sid,
      streamId: `session:${sid}`,
      source: "runtime:test",
      provenance: "observed",
    });
  });
});
