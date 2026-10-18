import { describe, expect, it } from "vitest";
import type { RuntimeSessionSpec } from "@mimir/protocol";
import { collectEvents, withFakeRuntime } from "./index.js";

const spec: RuntimeSessionSpec = {
  sessionId: "ses_1",
  idempotencyKey: "k",
  crewId: "crw_1",
  taskId: "tsk_1",
  agentKind: "claude",
  argv: [],
  cwd: "/tmp",
  env: {},
  workspaceLabel: "w",
};

describe("@mimir/testing", () => {
  it("withFakeRuntime exposes fake, clock and adapter", async () => {
    const { fake, clock } = withFakeRuntime([{ afterMs: 5, state: "running" }]);
    await fake.createSession(spec);
    clock.advance(5);
    expect((await fake.getSession("ses_1"))?.state).toBe("running");
  });

  it("collectEvents resolves once the kind is seen, driving the clock", async () => {
    const { fake, clock } = withFakeRuntime();
    await fake.createSession(spec);
    const events = await collectEvents(fake, "session.exited", { clock });
    expect(events.map((e) => e.kind)).toEqual([
      "session.state_changed",
      "session.output",
      "session.state_changed",
      "session.state_changed",
      "session.exited",
    ]);
  });

  it("collectEvents rejects if the kind never arrives", async () => {
    const { fake, clock } = withFakeRuntime([]);
    await fake.createSession(spec);
    await expect(collectEvents(fake, "session.exited", { clock, maxMs: 1000 })).rejects.toThrow(
      /session\.exited/,
    );
  });
});
