import { describe, expect, it } from "vitest";
import { ApprovalSchema, newId, payloadSchemaFor, type ApprovalId } from "@mimir/protocol";
import { ApprovalService, type ApprovalRequestInput } from "./approvals.js";
import { policyDeniedEvent, type PolicyDomainEvent } from "./events.js";
import type { Actor } from "./evaluate.js";

const T0 = Date.parse("2026-10-14T12:00:00.000Z");
const agent: Actor = { kind: "agent", id: "agt_1", role: "implementer" };
const human: Actor = { kind: "human", id: "usr_alice" };

function setup(start = T0) {
  let t = start;
  const clock = {
    set: (ms: number) => (t = ms),
    advance: (ms: number) => (t += ms),
  };
  const svc = new ApprovalService({ now: () => new Date(t) });
  return { svc, clock };
}

function input(overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    action: "git.push",
    requestedBy: agent,
    payloadSummary: "push task/T11 to origin",
    ttlMs: 60_000,
    ...overrides,
  };
}

function expectValidEvents(events: PolicyDomainEvent[]) {
  for (const e of events) {
    expect(() => payloadSchemaFor(e.type).parse(e.payload)).not.toThrow();
  }
}

describe("ApprovalService.request", () => {
  it("creates a pending, schema-valid approval with expiry = now + ttl", () => {
    const { svc } = setup();
    const missionId = newId("msn");
    const taskId = newId("tsk");
    const a = svc.request(input({ missionId, taskId }));
    expect(ApprovalSchema.parse(a)).toEqual(a);
    expect(a).toMatchObject({
      action: "git.push",
      status: "pending",
      actor: null,
      expiry: "2026-10-14T12:01:00.000Z",
      missionId,
      taskId,
      reason: null,
      version: 0,
      createdAt: "2026-10-14T12:00:00.000Z",
      updatedAt: "2026-10-14T12:00:00.000Z",
    });
    expect(a.id).toMatch(/^apr_/);
    expect(svc.get(a.id)).toEqual(a);
    expect(svc.requestedBy(a.id)).toEqual(agent);
    expect(svc.payloadSummary(a.id)).toBe("push task/T11 to origin");
  });

  it("emits approval.requested", () => {
    const { svc } = setup();
    const a = svc.request(input());
    const events = svc.takeEvents();
    expect(events).toEqual([
      {
        type: "approval.requested",
        payload: {
          approvalId: a.id,
          action: "git.push",
          expiry: "2026-10-14T12:01:00.000Z",
          reason: "push task/T11 to origin",
        },
      },
    ]);
    expectValidEvents(events);
    expect(svc.takeEvents()).toEqual([]);
  });

  it("defaults missionId/taskId to null", () => {
    const { svc } = setup();
    expect(svc.request(input())).toMatchObject({ missionId: null, taskId: null });
  });

  it.each([
    ["zero ttl", { ttlMs: 0 }],
    ["negative ttl", { ttlMs: -1 }],
    ["NaN ttl", { ttlMs: Number.NaN }],
    ["infinite ttl", { ttlMs: Number.POSITIVE_INFINITY }],
    ["ttl beyond the representable date range", { ttlMs: 1e300 }],
    ["empty summary", { payloadSummary: "  " }],
    ["unknown action", { action: "git.pull" as never }],
    ["empty requester id", { requestedBy: { kind: "agent", id: "" } as Actor }],
  ])("rejects %s with validation_failed", (_name, overrides) => {
    const { svc } = setup();
    expect(() => svc.request(input(overrides))).toThrowError(
      expect.objectContaining({ code: "validation_failed" }),
    );
    expect(svc.takeEvents()).toEqual([]);
  });

  it("uses an injected id generator", () => {
    const id = newId("apr");
    const svc = new ApprovalService({ now: () => new Date(T0), generateId: () => id });
    expect(svc.request(input()).id).toBe(id);
  });
});

describe("ApprovalService.decide", () => {
  it.each(["approved", "rejected"] as const)("%s by a different human", (decision) => {
    const { svc, clock } = setup();
    const a = svc.request(input());
    svc.takeEvents();
    clock.advance(5_000);
    const d = svc.decide(a.id, { decision, actor: human, reason: "looks fine" });
    expect(ApprovalSchema.parse(d)).toEqual(d);
    expect(d).toMatchObject({
      id: a.id,
      status: decision,
      actor: "usr_alice",
      reason: "looks fine",
      version: 1,
      createdAt: a.createdAt,
      updatedAt: "2026-10-14T12:00:05.000Z",
    });
    const events = svc.takeEvents();
    expect(events).toEqual([
      {
        type: "approval.decided",
        payload: { approvalId: a.id, decision, actor: "usr_alice", reason: "looks fine" },
      },
    ]);
    expectValidEvents(events);
  });

  it("does not mutate previously returned approvals", () => {
    const { svc } = setup();
    const a = svc.request(input());
    const before = structuredClone(a);
    svc.decide(a.id, { decision: "approved", actor: human, reason: "ok" });
    expect(a).toEqual(before);
  });

  type Case = {
    name: string;
    arrange: (ctx: ReturnType<typeof setup>, id: ApprovalId) => void;
    actor?: Actor;
    code: string;
    id?: ApprovalId;
  };
  const cases: Case[] = [
    { name: "unknown id", arrange: () => {}, id: newId("apr"), code: "not_found" },
    {
      name: "already approved",
      arrange: ({ svc }, id) => svc.decide(id, { decision: "approved", actor: human, reason: "" }),
      code: "invalid_transition",
    },
    {
      name: "already rejected",
      arrange: ({ svc }, id) => svc.decide(id, { decision: "rejected", actor: human, reason: "" }),
      code: "invalid_transition",
    },
    {
      name: "past expiry but not yet swept",
      arrange: ({ clock }) => clock.advance(60_000),
      code: "invalid_transition",
    },
    {
      name: "already expired",
      arrange: ({ svc, clock }) => {
        clock.advance(60_000);
        svc.expire();
      },
      code: "invalid_transition",
    },
    {
      name: "self-approval (same id as requester)",
      arrange: () => {},
      actor: { kind: "human", id: "agt_1" },
      code: "policy_denied",
    },
    {
      name: "agent decider",
      arrange: () => {},
      actor: { kind: "agent", id: "agt_2" },
      code: "policy_denied",
    },
    {
      name: "system decider",
      arrange: () => {},
      actor: { kind: "system", id: "scheduler" },
      code: "policy_denied",
    },
  ];

  it.each(cases)("rejects: $name ($code)", ({ arrange, actor, code, id }) => {
    const ctx = setup();
    const a = ctx.svc.request(input());
    arrange(ctx, a.id);
    const before = ctx.svc.get(a.id);
    ctx.svc.takeEvents();
    expect(() =>
      ctx.svc.decide(id ?? a.id, { decision: "approved", actor: actor ?? human, reason: "x" }),
    ).toThrowError(expect.objectContaining({ code }));
    expect(ctx.svc.get(a.id)).toEqual(before);
    expect(ctx.svc.takeEvents()).toEqual([]);
  });

  it("rejects self-approval when a human requested it", () => {
    const { svc } = setup();
    const a = svc.request(input({ requestedBy: human }));
    expect(() =>
      svc.decide(a.id, { decision: "approved", actor: human, reason: "mine" }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
  });

  it("rejects an unknown decision value", () => {
    const { svc } = setup();
    const a = svc.request(input());
    expect(() =>
      svc.decide(a.id, { decision: "maybe" as never, actor: human, reason: "" }),
    ).toThrowError(expect.objectContaining({ code: "validation_failed" }));
  });

  it("allows deciding just before expiry", () => {
    const { svc, clock } = setup();
    const a = svc.request(input());
    clock.advance(59_999);
    expect(svc.decide(a.id, { decision: "approved", actor: human, reason: "" }).status).toBe(
      "approved",
    );
  });
});

describe("ApprovalService.expire", () => {
  it("expires only pending approvals at or past expiry and emits approval.expired", () => {
    const { svc, clock } = setup();
    const short = svc.request(input({ ttlMs: 1_000 }));
    const exact = svc.request(input({ ttlMs: 2_000 }));
    const long = svc.request(input({ ttlMs: 10_000 }));
    const decided = svc.request(input({ ttlMs: 1_000 }));
    svc.decide(decided.id, { decision: "rejected", actor: human, reason: "no" });
    svc.takeEvents();
    clock.advance(500);

    const expired = svc.expire(new Date(T0 + 2_000));
    expect(expired.map((a) => a.id)).toEqual([short.id, exact.id]);
    for (const a of expired) {
      expect(a).toMatchObject({ status: "expired", version: 1 });
      expect(a.updatedAt).toBe("2026-10-14T12:00:02.000Z");
      expect(ApprovalSchema.parse(a)).toEqual(a);
    }
    expect(svc.get(long.id)?.status).toBe("pending");
    expect(svc.get(decided.id)?.status).toBe("rejected");

    const events = svc.takeEvents();
    expect(events).toEqual([
      { type: "approval.expired", payload: { approvalId: short.id } },
      { type: "approval.expired", payload: { approvalId: exact.id } },
    ]);
    expectValidEvents(events);

    expect(svc.expire(new Date(T0 + 2_000))).toEqual([]);
  });

  it("defaults to the injected clock", () => {
    const { svc, clock } = setup();
    const a = svc.request(input({ ttlMs: 1_000 }));
    expect(svc.expire()).toEqual([]);
    clock.advance(1_000);
    expect(svc.expire().map((x) => x.id)).toEqual([a.id]);
  });
});

describe("ApprovalService.list / seeding", () => {
  it("lists approvals in creation order and can be seeded with existing ones", () => {
    const { svc } = setup();
    const a = svc.request(input());
    const b = svc.request(input({ action: "deploy" }));
    expect(svc.list().map((x) => x.id)).toEqual([a.id, b.id]);

    const restored = new ApprovalService({
      now: () => new Date(T0),
      approvals: [{ approval: a, requestedBy: agent, payloadSummary: "p" }],
    });
    expect(restored.get(a.id)).toEqual(a);
    expect(() =>
      restored.decide(a.id, { decision: "approved", actor: agent, reason: "" }),
    ).toThrowError(expect.objectContaining({ code: "policy_denied" }));
  });
});

describe("policyDeniedEvent", () => {
  it.each([
    ["default decision", { effect: "deny", reason: "no rule" } as const, undefined],
    ["non-policy rule id", { effect: "deny", ruleId: "r1", reason: "rule r1" } as const, undefined],
  ])("%s has no policyId", (_n, decision, policyId) => {
    const e = policyDeniedEvent("git.push", decision);
    expect(e).toEqual({
      type: "policy.denied",
      payload: { action: "git.push", reason: decision.reason },
    });
    expect(e.payload.policyId).toBe(policyId);
    expectValidEvents([e]);
  });

  it("extracts policyId from rulesFromPolicy ids", () => {
    const pol = newId("pol");
    const e = policyDeniedEvent("deploy", { effect: "deny", ruleId: `${pol}#2`, reason: "r" });
    expect(e.payload).toEqual({ action: "deploy", reason: "r", policyId: pol });
    expectValidEvents([e]);
  });
});
