import { describe, expect, it } from "vitest";
import { openEventStore } from "./event-store.js";

describe("AuditLog", () => {
  it("records entries and lists them in insertion order", () => {
    const store = openEventStore(":memory:");
    const a = store.audit.record({
      actor: "user:jacob",
      action: "approval.decide",
      target: "apr_1",
      decision: "approved",
      reason: "ok",
    });
    const b = store.audit.record({ actor: "system", action: "policy.check" });
    expect(a).toMatchObject({
      actor: "user:jacob",
      action: "approval.decide",
      target: "apr_1",
      decision: "approved",
      reason: "ok",
    });
    expect(a.id).toMatch(/^aud_/);
    expect(Number.isNaN(Date.parse(a.createdAt))).toBe(false);
    expect(b).toEqual({
      id: b.id,
      actor: "system",
      action: "policy.check",
      createdAt: b.createdAt,
    });
    expect(store.audit.list()).toEqual([a, b]);
    store.close();
  });
});
