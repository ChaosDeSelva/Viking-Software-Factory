import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeSessionSpec } from "@mimir/protocol";
import { FakeRuntime, ManualClock, type ScriptStep } from "./fake-runtime.js";

const spec = (over: Partial<RuntimeSessionSpec> = {}): RuntimeSessionSpec => ({
  sessionId: "ses_1",
  idempotencyKey: "key-1",
  crewId: "crw_1",
  taskId: "tsk_1",
  agentKind: "claude",
  argv: ["claude"],
  cwd: "/tmp/w",
  env: {},
  workspaceLabel: "w",
  ...over,
});

async function setup(script?: readonly ScriptStep[]) {
  const clock = new ManualClock();
  const fake = new FakeRuntime(script ? { clock, script } : { clock });
  const events: RuntimeEvent[] = [];
  await fake.subscribe((e) => events.push(e));
  return { clock, fake, events };
}

describe("FakeRuntime default script", () => {
  it("emits events in deterministic order with monotonic sourceEventId", async () => {
    const { clock, fake, events } = await setup();
    const s = await fake.createSession(spec());
    expect(s.state).toBe("starting");
    clock.advance(99);
    expect(events).toEqual([]);
    clock.advance(1);
    expect(events.map((e) => e.kind)).toEqual(["session.state_changed", "session.output"]);
    clock.advance(1000);
    const summary = events.map((e) =>
      e.kind === "session.state_changed" ? e.state : e.kind === "session.output" ? e.text : e.kind,
    );
    expect(summary).toEqual(["running", "working...", "idle", "completed", "session.exited"]);
    const ids = events.flatMap((e) =>
      e.kind === "session.state_changed" ? [Number(e.sourceEventId)] : [],
    );
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    const exit = events.find((e) => e.kind === "session.exited");
    expect(exit).toMatchObject({ exitCode: 0 });
    expect((await fake.getSession("ses_1"))?.state).toBe("completed");
  });

  it("stamps observedAt from the clock", async () => {
    const { clock, fake, events } = await setup();
    await fake.createSession(spec());
    clock.advance(100);
    expect(events[0]?.observedAt).toBe(new Date(100).toISOString());
  });
});

describe("createSession idempotency", () => {
  it("returns the same session for the same key and spec", async () => {
    const { fake } = await setup();
    const a = await fake.createSession(spec());
    const b = await fake.createSession(spec());
    expect(b).toEqual(a);
    expect(await fake.listSessions()).toHaveLength(1);
  });

  it("throws conflict for same key with a different spec", async () => {
    const { fake } = await setup();
    await fake.createSession(spec());
    await expect(fake.createSession(spec({ taskId: "tsk_2" }))).rejects.toMatchObject({
      code: "conflict",
    });
  });
});

describe("blocked sessions", () => {
  it("sendInput logs input and moves blocked to running", async () => {
    const { clock, fake, events } = await setup([{ afterMs: 10, state: "blocked" }]);
    await fake.createSession(spec());
    clock.advance(10);
    expect((await fake.getSession("ses_1"))?.state).toBe("blocked");
    await fake.sendInput("ses_1", { text: "yes" });
    expect(fake.inputs["ses_1"]).toEqual([{ text: "yes" }]);
    expect((await fake.getSession("ses_1"))?.state).toBe("running");
    expect(events.at(-1)).toMatchObject({ kind: "session.state_changed", state: "running" });
  });

  it("sendInput on an unknown session throws not_found", async () => {
    const { fake } = await setup();
    await expect(fake.sendInput("nope", { text: "x" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("requestStop", () => {
  it("soft goes stopping then stopped after 50ms", async () => {
    const { clock, fake } = await setup([]);
    await fake.createSession(spec());
    await fake.requestStop("ses_1", "soft");
    expect((await fake.getSession("ses_1"))?.state).toBe("stopping");
    clock.advance(49);
    expect((await fake.getSession("ses_1"))?.state).toBe("stopping");
    clock.advance(1);
    expect((await fake.getSession("ses_1"))?.state).toBe("stopped");
  });

  it("force stops immediately and cancels remaining script", async () => {
    const { clock, fake, events } = await setup();
    await fake.createSession(spec());
    await fake.requestStop("ses_1", "force");
    expect((await fake.getSession("ses_1"))?.state).toBe("stopped");
    const n = events.length;
    clock.advance(5000);
    expect(events).toHaveLength(n);
  });
});

describe("chaos", () => {
  it("dropNextEvents drops transitions but state still changes", async () => {
    const { clock, fake, events } = await setup();
    await fake.createSession(spec());
    fake.chaos({ dropNextEvents: 2 });
    clock.advance(100);
    expect(events).toEqual([]);
    expect((await fake.getSession("ses_1"))?.state).toBe("running");
    clock.advance(500);
    expect(events.map((e) => e.kind)).toContain("session.state_changed");
  });

  it("emitGap emits runtime.gap", async () => {
    const { fake, events } = await setup();
    fake.chaos({ emitGap: true });
    expect(events).toMatchObject([{ kind: "runtime.gap", reason: "events_lost" }]);
  });
});

describe("reconcile", () => {
  it("lists sessions and lost ids", async () => {
    const { fake, events } = await setup([]);
    await fake.createSession(spec());
    await fake.createSession(spec({ sessionId: "ses_2", idempotencyKey: "k2" }));
    fake.loseSession("ses_2");
    expect(events.at(-1)).toMatchObject({ kind: "session.lost", sessionId: "ses_2" });
    const r = await fake.reconcile();
    expect(r.lost).toEqual(["ses_2"]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["ses_1"]);
  });
});

describe("capabilities", () => {
  it("everything true except pause and multiHost", async () => {
    const { fake } = await setup();
    const c = await fake.capabilities();
    const off = Object.entries(c.features)
      .filter(([, v]) => !v)
      .map(([k]) => k)
      .sort();
    expect(off).toEqual(["multiHost", "pause"]);
  });
});

describe("subscribe", () => {
  it("close stops delivery", async () => {
    const clock = new ManualClock();
    const fake = new FakeRuntime({ clock });
    const events: RuntimeEvent[] = [];
    const sub = await fake.subscribe((e) => events.push(e));
    sub.close();
    await fake.createSession(spec());
    clock.advance(1000);
    expect(events).toEqual([]);
  });
});

describe("readTerminal (capabilities advertise terminalRead)", () => {
  it("returns the session's scripted output and operator input, last N lines", async () => {
    const clock = new ManualClock();
    const fake = new FakeRuntime({ clock });
    await fake.createSession(
      spec({ sessionId: "ses_01J00000000000000000000001", idempotencyKey: "k-term" }),
    );
    clock.advance(1000);
    await fake.sendInput("ses_01J00000000000000000000001", { text: "hello there" });
    expect(await fake.readTerminal("ses_01J00000000000000000000001")).toBe(
      "working...\n> hello there\n",
    );
    expect(await fake.readTerminal("ses_01J00000000000000000000001", 1)).toBe("> hello there\n");
    await expect(fake.readTerminal("ses_01J00000000000000000000099")).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
