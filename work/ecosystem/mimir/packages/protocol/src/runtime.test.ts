import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { MimirError } from "./errors.js";
import {
  RUNTIME_FEATURES,
  RuntimeCapabilitiesSchema,
  RuntimeEventSchema,
  RuntimeSessionSchema,
  RuntimeSessionSpecSchema,
  requireCapability,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionSpec,
} from "./runtime.js";

const now = "2026-10-14T08:00:00.000Z";

const caps: RuntimeCapabilities = {
  runtime: "fake",
  version: "0.0.1",
  features: {
    createSession: true,
    sendInput: true,
    sendKeys: false,
    softStop: true,
    forceStop: true,
    pause: false,
    subscribe: true,
    terminalRead: false,
    processInfo: false,
    multiHost: false,
    notify: false,
  },
  agentKinds: ["claude"],
};

describe("runtime schemas", () => {
  it("schemas infer exactly the interface types", () => {
    expectTypeOf<z.infer<typeof RuntimeCapabilitiesSchema>>().toEqualTypeOf<RuntimeCapabilities>();
    expectTypeOf<z.infer<typeof RuntimeSessionSpecSchema>>().toEqualTypeOf<RuntimeSessionSpec>();
    expectTypeOf<z.infer<typeof RuntimeSessionSchema>>().toEqualTypeOf<RuntimeSession>();
    expectTypeOf<z.infer<typeof RuntimeEventSchema>>().toEqualTypeOf<RuntimeEvent>();
  });

  it("lists every feature flag", () => {
    expect([...RUNTIME_FEATURES].sort()).toEqual(Object.keys(caps.features).sort());
  });

  it("RuntimeCapabilitiesSchema validates and reports paths", () => {
    expect(RuntimeCapabilitiesSchema.parse(caps)).toEqual(caps);
    const bad = RuntimeCapabilitiesSchema.safeParse({
      ...caps,
      features: { ...caps.features, pause: "no" },
    });
    expect(bad.error?.issues[0]?.path).toEqual(["features", "pause"]);
  });

  it("RuntimeSessionSpecSchema validates", () => {
    const spec: RuntimeSessionSpec = {
      sessionId: "ses_1",
      idempotencyKey: "k",
      crewId: "crw_1",
      taskId: "tsk_1",
      agentKind: "claude",
      argv: ["claude"],
      cwd: "/wt/1",
      env: { FOO: "bar" },
      workspaceLabel: "mimir/t1",
    };
    expect(RuntimeSessionSpecSchema.parse(spec)).toEqual(spec);
    expect(
      RuntimeSessionSpecSchema.safeParse({ ...spec, env: { FOO: 1 } }).error?.issues[0]?.path,
    ).toEqual(["env", "FOO"]);
  });

  it("RuntimeSessionSchema validates state", () => {
    const s: RuntimeSession = {
      sessionId: "ses_1",
      runtimeRef: { paneId: "p1" },
      state: "running",
      lastObservedAt: now,
    };
    expect(RuntimeSessionSchema.parse(s)).toEqual(s);
    expect(
      RuntimeSessionSchema.safeParse({ ...s, state: "zombie" }).error?.issues[0]?.path,
    ).toEqual(["state"]);
  });

  it("RuntimeEventSchema accepts every kind and rejects unknown kinds", () => {
    const events: RuntimeEvent[] = [
      { kind: "session.state_changed", sessionId: "s", state: "idle", observedAt: now },
      { kind: "session.output", sessionId: "s", text: "hi", observedAt: now },
      { kind: "session.exited", sessionId: "s", exitCode: 0, observedAt: now },
      { kind: "session.lost", sessionId: "s", reason: "gone", observedAt: now },
      { kind: "runtime.gap", reason: "reconnect", observedAt: now },
    ];
    for (const e of events) expect(RuntimeEventSchema.parse(e)).toEqual(e);
    expect(
      RuntimeEventSchema.safeParse({ kind: "runtime.gap", reason: "x", observedAt: now }).error
        ?.issues[0]?.path,
    ).toEqual(["reason"]);
    expect(RuntimeEventSchema.safeParse({ kind: "nope", observedAt: now }).success).toBe(false);
  });
});

describe("RuntimeAdapter contract", () => {
  it("requireCapability throws capability_unavailable for unsupported features", () => {
    expect(() => requireCapability(caps, "createSession")).not.toThrow();
    try {
      requireCapability(caps, "sendKeys");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MimirError);
      expect((err as MimirError).code).toBe("capability_unavailable");
      expect((err as MimirError).status).toBe(501);
      expect((err as MimirError).details).toEqual({ runtime: "fake", feature: "sendKeys" });
    }
  });

  it("can be implemented by a minimal adapter", async () => {
    const sessions = new Map<string, RuntimeSession>();
    const adapter: RuntimeAdapter = {
      capabilities: async () => caps,
      health: async () => ({ ok: true }),
      createSession: async (spec) => {
        const s: RuntimeSession = {
          sessionId: spec.sessionId,
          runtimeRef: {},
          state: "starting",
          agentKind: spec.agentKind,
          cwd: spec.cwd,
          lastObservedAt: now,
        };
        sessions.set(s.sessionId, s);
        return s;
      },
      listSessions: async () => [...sessions.values()],
      getSession: async (id) => sessions.get(id) ?? null,
      sendInput: async (_id, input) => {
        if (input.keys) requireCapability(caps, "sendKeys");
      },
      subscribe: async () => ({ close: () => undefined }),
      requestStop: async () => undefined,
      reconcile: async () => ({ sessions: [...sessions.values()], lost: [] }),
      dispose: async () => undefined,
    };
    await adapter.createSession({
      sessionId: "ses_1",
      idempotencyKey: "k",
      crewId: "c",
      taskId: "t",
      agentKind: "claude",
      argv: [],
      cwd: "/",
      env: {},
      workspaceLabel: "w",
    });
    expect((await adapter.listSessions()).length).toBe(1);
    await expect(adapter.sendInput("ses_1", { keys: ["Enter"] })).rejects.toMatchObject({
      code: "capability_unavailable",
    });
  });
});
