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
