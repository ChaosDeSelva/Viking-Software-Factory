import { MimirError, newId } from "@mimir/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { T0, at } from "./testing/fixtures.js";
import { DEFAULT_LEASE_MS, leaseManager, leaseTtlMs, type Lease } from "./lease.js";

const now0 = new Date(T0);
const crewId = newId("crw");
const ses = newId("ses");
const TTL = 30_000;

function errOf(fn: () => unknown): MimirError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(MimirError);
    return e as MimirError;
  }
  throw new Error("expected throw");
}

describe("leaseManager.grant", () => {
  it("adds a lease expiring now + ttl", () => {
    const taskId = newId("tsk");
    const leases = leaseManager.grant([], { taskId, crewId, sessionId: null }, now0, TTL);
    expect(leases).toEqual([
      { taskId, crewId, sessionId: null, heartbeatAt: T0, expiresAt: at(TTL) },
    ]);
  });

  it("refuses a second live lease for the same task", () => {
    const taskId = newId("tsk");
    const leases = leaseManager.grant([], { taskId, crewId, sessionId: null }, now0, TTL);
    const err = errOf(() =>
      leaseManager.grant(leases, { taskId, crewId, sessionId: null }, new Date(at(1000)), TTL),
    );
    expect(err.code).toBe("conflict");
  });

  it("replaces an expired lease for the same task", () => {
    const taskId = newId("tsk");
    const first = leaseManager.grant([], { taskId, crewId, sessionId: null }, now0, TTL);
    const later = new Date(at(TTL));
    const second = leaseManager.grant(first, { taskId, crewId, sessionId: ses }, later, TTL);
    expect(second).toHaveLength(1);
    expect(second[0]!.expiresAt).toBe(at(2 * TTL));
  });

  it("rejects non-positive ttl", () => {
    expect(
      errOf(() =>
        leaseManager.grant([], { taskId: newId("tsk"), crewId, sessionId: null }, now0, 0),
      ).code,
    ).toBe("validation_failed");
  });
});

describe("leaseManager.heartbeat", () => {
  const taskId = newId("tsk");
  const base = leaseManager.grant([], { taskId, crewId, sessionId: ses }, now0, TTL);

  it.each([
    // offset, sessionId, expected outcome
    [1_000, ses, "ok"],
    [TTL - 1, ses, "ok"],
    [TTL, ses, "conflict"], // expired exactly at expiresAt
    [1_000, newId("ses"), "conflict"], // wrong session
  ] as const)("at +%ims -> %s", (offset, sessionId, outcome) => {
    const now = new Date(at(offset));
    if (outcome === "ok") {
      const [l] = leaseManager.heartbeat(base, taskId, now, TTL, sessionId);
      expect(l!.heartbeatAt).toBe(at(offset));
      expect(l!.expiresAt).toBe(at(offset + TTL));
    } else {
      expect(errOf(() => leaseManager.heartbeat(base, taskId, now, TTL, sessionId)).code).toBe(
        outcome,
      );
    }
  });

  it("unknown task -> not_found", () => {
    expect(errOf(() => leaseManager.heartbeat(base, newId("tsk"), now0, TTL)).code).toBe(
      "not_found",
    );
  });

  it("binds a session to a lease granted without one", () => {
    const l0 = leaseManager.grant([], { taskId, crewId, sessionId: null }, now0, TTL);
    const [l] = leaseManager.heartbeat(l0, taskId, new Date(at(10)), TTL, ses);
    expect(l!.sessionId).toBe(ses);
  });
});

describe("leaseManager.expire", () => {
  it("removes expired leases and emits expire decisions in (expiresAt, taskId) order", () => {
    const a = newId("tsk");
    const b = newId("tsk");
    const c = newId("tsk");
    let leases: Lease[] = [];
    leases = leaseManager.grant(leases, { taskId: c, crewId, sessionId: null }, now0, 2_000);
    leases = leaseManager.grant(leases, { taskId: a, crewId, sessionId: null }, now0, 1_000);
    leases = leaseManager.grant(leases, { taskId: b, crewId, sessionId: null }, now0, 10_000);
    const out = leaseManager.expire(leases, new Date(at(2_000)));
    expect(out.decisions).toEqual([
      { kind: "expire", taskId: a },
      { kind: "expire", taskId: c },
    ]);
    expect(out.leases.map((l) => l.taskId)).toEqual([b]);
  });

  it("property: partition is exact and pure", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100_000 }), { maxLength: 15 }),
        fc.integer({ min: 0, max: 120_000 }),
        (ttls, nowOffset) => {
          const leases = ttls.reduce<Lease[]>(
            (acc, ttl) =>
              leaseManager.grant(acc, { taskId: newId("tsk"), crewId, sessionId: null }, now0, ttl),
            [],
          );
          const snapshot = structuredClone(leases);
          const now = new Date(at(nowOffset));
          const out = leaseManager.expire(leases, now);
          expect(leases).toEqual(snapshot);
          expect(out.leases.length + out.decisions.length).toBe(leases.length);
          for (const l of out.leases) expect(leaseManager.isExpired(l, now)).toBe(false);
          const expired = new Set(out.decisions.map((d) => d.taskId));
          for (const l of leases) {
            expect(expired.has(l.taskId)).toBe(leaseManager.isExpired(l, now));
          }
          expect(leaseManager.expire(leases, now)).toEqual(out);
        },
      ),
    );
  });
});

describe("leaseTtlMs", () => {
  it.each([
    [{}, DEFAULT_LEASE_MS],
    [{ leaseSeconds: 45 }, 45_000],
  ])("%j -> %i", (limits, want) => {
    expect(leaseTtlMs({ limits })).toBe(want);
  });
});
