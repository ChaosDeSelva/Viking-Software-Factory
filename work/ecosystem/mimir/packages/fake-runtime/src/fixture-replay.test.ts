import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RuntimeEvent } from "@mimir/protocol";
import { FixtureReplayRuntime, herdrFixturePath, type Normalizer } from "./fixture-replay.js";

const normalize: Normalizer = (line) => {
  const rec = JSON.parse(line) as {
    kind?: string;
    msg?: { event?: string; data?: { pane?: { pane_id?: string } } };
  };
  if (rec.kind !== "event" || rec.msg?.event !== "pane_created") return null;
  return {
    kind: "session.state_changed",
    sessionId: rec.msg.data?.pane?.pane_id ?? "?",
    state: "starting",
    observedAt: new Date(0).toISOString(),
  };
};

describe("FixtureReplayRuntime", () => {
  it("replays normalized events instantly at speed 0", async () => {
    const lines = readFileSync(herdrFixturePath("lifecycle-events.ndjson"), "utf8").split("\n");
    const rt = new FixtureReplayRuntime({ lines, normalize, speed: 0 });
    const got: RuntimeEvent[] = [];
    await rt.subscribe((e) => got.push(e));
    await rt.play();
    expect(got.length).toBe(2);
    expect(got[0]).toMatchObject({ kind: "session.state_changed", state: "starting" });
  });

  it("paces by t_ms when speed > 0 using the injected sleep", async () => {
    const sleeps: number[] = [];
    const lines = [
      '{"t_ms":10,"kind":"event","msg":{"event":"pane_created","data":{"pane":{"pane_id":"a"}}}}',
      '{"t_ms":110,"kind":"event","msg":{"event":"pane_created","data":{"pane":{"pane_id":"b"}}}}',
    ];
    const rt = new FixtureReplayRuntime({
      lines,
      normalize,
      speed: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await rt.play();
    expect(sleeps).toEqual([50]);
  });

  it("fromFile loads a fixture and unsupported operations throw capability_unavailable", async () => {
    const rt = FixtureReplayRuntime.fromFile(herdrFixturePath("restart-events.ndjson"), normalize);
    await expect(rt.createSession({} as never)).rejects.toMatchObject({
      code: "capability_unavailable",
    });
    expect(await rt.listSessions()).toEqual([]);
  });
});

describe("FixtureReplayRuntime adapter surface", () => {
  const line = (id: string, t?: unknown) =>
    JSON.stringify({
      ...(t === undefined ? {} : { t_ms: t }),
      kind: "event",
      msg: { event: "pane_created", data: { pane: { pane_id: id } } },
    });

  it("advertises only subscribe and is always healthy with no sessions", async () => {
    const rt = new FixtureReplayRuntime({ lines: [], normalize });
    const caps = await rt.capabilities();
    expect(caps.runtime).toBe("fixture-replay");
    expect(Object.entries(caps.features).filter(([, v]) => v)).toEqual([["subscribe", true]]);
    expect(await rt.health()).toEqual({ ok: true });
    expect(await rt.getSession()).toBeNull();
    expect(await rt.reconcile()).toEqual({ sessions: [], lost: [] });
  });

  it("rejects input and stop as unsupported", async () => {
    const rt = new FixtureReplayRuntime({ lines: [], normalize });
    await expect(rt.sendInput()).rejects.toMatchObject({
      code: "capability_unavailable",
      details: { runtime: "fixture-replay", feature: "sendInput" },
    });
    await expect(rt.requestStop()).rejects.toMatchObject({
      details: { feature: "requestStop" },
    });
  });

  it("stops delivering after close or dispose", async () => {
    const rt = new FixtureReplayRuntime({ lines: [line("a")], normalize });
    const a: RuntimeEvent[] = [];
    const b: RuntimeEvent[] = [];
    const sub = await rt.subscribe((e) => a.push(e));
    await rt.subscribe((e) => b.push(e));
    await rt.play();
    sub.close();
    await rt.play();
    await rt.dispose();
    await rt.play();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it("only paces forward steps between lines that carry a numeric t_ms", async () => {
    const sleeps: number[] = [];
    const rt = new FixtureReplayRuntime({
      lines: [line("a", 100), "not json", line("b", "200"), line("c", 50), line("d", 80), "  "],
      normalize: (l) => (l.startsWith("{") ? normalize(l) : null),
      speed: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const got: RuntimeEvent[] = [];
    await rt.subscribe((e) => got.push(e));
    await rt.play();
    expect(sleeps).toEqual([30]);
    expect(got).toHaveLength(4);
  });

  it("sleeps for real by default", async () => {
    const rt = new FixtureReplayRuntime({
      lines: [line("a", 0), line("b", 5)],
      normalize,
      speed: 1,
    });
    const got: RuntimeEvent[] = [];
    await rt.subscribe((e) => got.push(e));
    await rt.play();
    expect(got).toHaveLength(2);
  });
});
