import { join } from "node:path";
import { openEventStore } from "@mimir/core";
import { newId, type EventEnvelope, type RuntimeSessionSpec } from "@mimir/protocol";
import { openSse, recordRuntime, withFakeRuntime } from "@mimir/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH, makeServer } from "../../src/test-helpers.js";
import { tempDataDir } from "./support.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const spec = (sessionId: string): RuntimeSessionSpec => ({
  sessionId,
  idempotencyKey: `create:${sessionId}`,
  crewId: newId("crw"),
  taskId: newId("tsk"),
  agentKind: "shell",
  argv: ["true"],
  cwd: "/tmp",
  env: {},
  workspaceLabel: "chaos",
});

/**
 * There is no server-side runtime ingestion yet (the orchestrator, T12, owns it), so the gap is
 * recorded through the `recordRuntime` test bridge into the server's real store, and checked
 * through the server's HTTP and SSE surfaces.
 */
describe("chaos: runtime disconnect (FakeRuntime emitGap)", () => {
  it("records the gap, re-reconciles, and appends no duplicate session events", async () => {
    const tmp = tempDataDir();
    cleanups.push(tmp.cleanup);
    const store = openEventStore(join(tmp.dir, "mimir.db"));
    const { fake, clock } = withFakeRuntime();
    const server = makeServer({ runtime: fake }, store);
    cleanups.push(() => server.close());
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = server.app.server.address() as { port: number };
    const sse = await openSse(
      `http://127.0.0.1:${port}/v1/events/stream?types=recovery.reconciled`,
      AUTH,
    );
    cleanups.push(() => sse.close());

    const rec1 = await recordRuntime(fake, store);
    const a = newId("ses");
    const b = newId("ses");
    await fake.createSession(spec(a));
    await fake.createSession(spec(b));
    clock.advance(150); // both running, one output line each
    fake.chaos({ dropNextEvents: 2 });
    clock.advance(400); // both go idle, but the two transitions are lost
    fake.chaos({ emitGap: true });
    await rec1.idle();
    fake.chaos({ emitGap: true }); // re-reconcile with nothing new
    await rec1.idle();
    rec1.close();
    const rec2 = await recordRuntime(fake, store); // a restarted bridge reconciles again
    fake.chaos({ emitGap: true });
    await rec2.idle();
    clock.advance(100); // both complete and exit
    rec2.close();

    const res = await server.app.inject({ url: "/v1/events?limit=1000", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const events = (res.json() as { events: EventEnvelope[] }).events;

    const gaps = events.filter((e) => e.type === "recovery.reconciled");
    expect(gaps.map((e) => e.payload)).toEqual([
      { sessions: 2, lostSessionIds: [], gap: true },
      { sessions: 2, lostSessionIds: [], gap: true },
      { sessions: 2, lostSessionIds: [], gap: true },
    ]);
    for (const sid of [a, b]) {
      const mine = events.filter((e) => e.sessionId === sid);
      const states = mine
        .filter((e) => e.type === "session.state_changed")
        .map((e) => (e.payload as { to: string }).to);
      // The lost idle transition is restored once by the first reconcile; nothing repeats.
      expect(states).toEqual(["running", "idle", "completed"]);
      expect(mine.filter((e) => e.type === "session.exited")).toHaveLength(1);
      expect(mine.every((e) => e.provenance === "observed")).toBe(true);
    }

    // SSE subscribers see the recorded gap live.
    const live: string[] = [];
    while (live.length < 3) {
      const m = await sse.next(5000);
      if (m.event !== undefined) live.push(m.event);
    }
    expect(live).toEqual(["recovery.reconciled", "recovery.reconciled", "recovery.reconciled"]);
  });

  it("a lost session is recorded once even when every reconcile reports it", async () => {
    const tmp = tempDataDir();
    cleanups.push(tmp.cleanup);
    const store = openEventStore(join(tmp.dir, "mimir.db"));
    cleanups.push(() => store.close());
    const { fake, clock } = withFakeRuntime();
    const rec = await recordRuntime(fake, store);
    const sid = newId("ses");
    await fake.createSession(spec(sid));
    clock.advance(150);
    fake.chaos({ dropNextEvents: 1 });
    fake.loseSession(sid); // the session.lost notification itself is dropped
    fake.chaos({ emitGap: true });
    await rec.idle();
    fake.chaos({ emitGap: true });
    await rec.idle();
    rec.close();
    const { events } = store.read({ limit: 1000 });
    expect(events.filter((e) => e.type === "session.lost")).toHaveLength(1);
    expect(events.filter((e) => e.type === "recovery.reconciled").map((e) => e.payload)).toEqual([
      { sessions: 0, lostSessionIds: [sid], gap: true },
      { sessions: 0, lostSessionIds: [sid], gap: true },
    ]);
  });
});
