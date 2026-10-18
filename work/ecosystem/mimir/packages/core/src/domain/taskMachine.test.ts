import { MimirError, TaskStatusSchema, type TaskStatus } from "@mimir/protocol";
import { describe, expect, it } from "vitest";
import { makeTask } from "./testing/fixtures.js";
import {
  APPROVAL_REQUIRED,
  BUDGET_EXCEEDED,
  BUDGET_UNCERTAIN,
  POLICY_DENIED,
  TASK_TERMINAL_STATUSES,
  UNKNOWN_AFTER_RESTART,
  attemptsLeft,
  isParked,
  isTaskSettled,
  taskMachine,
  type TaskEvent,
} from "./taskMachine.js";

const ALL: readonly TaskStatus[] = TaskStatusSchema.options;
const LEASE_AT = "2026-01-01T00:05:00.000Z";

/** One representative event per event type. */
const EVENTS: Record<TaskEvent["type"], TaskEvent> = {
  deps_completed: { type: "deps_completed" },
  lease_granted: { type: "lease_granted", crewId: null, leaseExpiresAt: LEASE_AT },
  session_started: { type: "session_started", agentId: null },
  runtime_completed: { type: "runtime_completed" },
  verification_passed: { type: "verification_passed" },
  verification_failed: { type: "verification_failed" },
  verification_gated: { type: "verification_gated" },
  runtime_blocked: { type: "runtime_blocked", reason: "needs input" },
  approval_needed: { type: "approval_needed", reason: "push" },
  input_received: { type: "input_received" },
  approval_granted: { type: "approval_granted" },
  cancel: { type: "cancel" },
  runtime_failed: { type: "runtime_failed", reason: "crash" },
  runtime_lost: { type: "runtime_lost" },
  lease_expired: { type: "lease_expired" },
  retry: { type: "retry" },
  budget_exceeded: { type: "budget_exceeded" },
  budget_restored: { type: "budget_restored" },
  dispatch_gated: { type: "dispatch_gated", reason: APPROVAL_REQUIRED },
  dispatch_approved: { type: "dispatch_approved" },
  dispatch_denied: { type: "dispatch_denied" },
  recovery_unknown: { type: "recovery_unknown" },
};

/**
 * Test states: every TaskStatus, with `blocked` split by why it is blocked
 * (runtime/approval vs budget), because the exits differ.
 */
type State =
  | TaskStatus
  | "blocked:budget"
  | "blocked:uncertain"
  | "blocked:approval"
  | "blocked:denied"
  | "blocked:unknown";
const PARKED: Record<string, string> = {
  "blocked:budget": BUDGET_EXCEEDED,
  "blocked:uncertain": BUDGET_UNCERTAIN,
  "blocked:approval": APPROVAL_REQUIRED,
  "blocked:denied": POLICY_DENIED,
  "blocked:unknown": UNKNOWN_AFTER_RESTART,
};
const STATES: readonly State[] = [
  ...ALL,
  "blocked:budget",
  "blocked:uncertain",
  "blocked:approval",
  "blocked:denied",
  "blocked:unknown",
];
function taskIn(state: State, over: Parameters<typeof makeTask>[0] = {}) {
  const parked = PARKED[state];
  if (parked !== undefined) {
    return makeTask({ status: "blocked", blockedReason: parked, ...over });
  }
  if (state === "blocked")
    return makeTask({ status: "blocked", blockedReason: "needs input", ...over });
  return makeTask({ status: state as TaskStatus, ...over });
}

/**
 * The full allowed edge table, as (from, event) -> to. With attempts left
 * (attempt 0 of 3). Anything absent is forbidden.
 */
const ALLOWED: ReadonlyArray<[State, TaskEvent["type"], TaskStatus]> = [
  ["pending", "deps_completed", "ready"],
  ["ready", "lease_granted", "leased"],
  ["leased", "session_started", "running"],
  ["running", "runtime_completed", "verifying"],
  ["verifying", "verification_passed", "completed"],
  ["verifying", "verification_failed", "running"],
  ["verifying", "verification_gated", "blocked"],
  ["running", "runtime_blocked", "blocked"],
  ["running", "approval_needed", "blocked"],
  ["blocked", "input_received", "running"],
  ["blocked", "approval_granted", "running"],
  ["pending", "cancel", "cancelled"],
  ["ready", "cancel", "cancelled"],
  ["leased", "cancel", "cancelled"],
  ["running", "cancel", "cancelled"],
  ["verifying", "cancel", "cancelled"],
  ["blocked", "cancel", "cancelled"],
  ["blocked:budget", "cancel", "cancelled"],
  ["ready", "budget_exceeded", "blocked"],
  ["blocked:budget", "budget_restored", "ready"],
  ["failed", "cancel", "cancelled"],
  ["running", "runtime_failed", "failed"],
  ["running", "runtime_lost", "failed"],
  ["running", "lease_expired", "failed"],
  ["leased", "runtime_failed", "failed"],
  ["leased", "runtime_lost", "failed"],
  ["leased", "lease_expired", "failed"],
  ["failed", "retry", "ready"],
  // dispatch gated by policy (T12): parked before any lease, released by an approval
  ["ready", "dispatch_gated", "blocked"],
  ["blocked:approval", "dispatch_approved", "ready"],
  ["blocked:approval", "dispatch_denied", "blocked"],
  ["blocked:approval", "cancel", "cancelled"],
  ["blocked:denied", "cancel", "cancelled"],
  // restart recovery (T12): a leased/running task whose session vanished is never auto-completed
  ["leased", "recovery_unknown", "blocked"],
  ["running", "recovery_unknown", "blocked"],
  ["blocked:unknown", "retry", "ready"],
  ["blocked:unknown", "cancel", "cancelled"],
  // fix round 1: uncertain budgets, recovery of runtime-blocked tasks, retry after a denial
  ["blocked:uncertain", "budget_restored", "ready"],
  ["blocked:uncertain", "cancel", "cancelled"],
  ["blocked", "recovery_unknown", "blocked"],
  ["blocked:denied", "retry", "ready"],
];

const allowedKey = new Set(ALLOWED.map(([f, e]) => `${f}|${e}`));
const FORBIDDEN: Array<[State, TaskEvent["type"]]> = [];
for (const from of STATES) {
  for (const ev of Object.keys(EVENTS) as TaskEvent["type"][]) {
    if (!allowedKey.has(`${from}|${ev}`)) FORBIDDEN.push([from, ev]);
  }
}

describe("taskMachine.transition: allowed edges", () => {
  it.each(ALLOWED)("%s --%s--> %s", (from, ev, to) => {
    const task = taskIn(from, { attempt: 0, maxAttempts: 3 });
    const before = structuredClone(task);
    const next = taskMachine.transition(task, EVENTS[ev]);
    expect(next.status).toBe(to);
    expect(task).toEqual(before); // input not mutated
    expect(taskMachine.can(task, ev)).toBe(true);
    expect(taskMachine.target(task, ev)).toBe(to);
  });
});

describe("taskMachine.transition: forbidden edges", () => {
  it("covers every (status, event) pair", () => {
    expect(ALLOWED.length + FORBIDDEN.length).toBe(STATES.length * Object.keys(EVENTS).length);
  });

  it.each(FORBIDDEN)("%s --%s--> invalid_transition", (from, ev) => {
    const task = taskIn(from, { attempt: 0, maxAttempts: 3 });
    expect(taskMachine.can(task, ev)).toBe(false);
    expect(taskMachine.target(task, ev)).toBeNull();
    let err: unknown;
    try {
      taskMachine.transition(task, EVENTS[ev]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MimirError);
    const m = err as MimirError;
    expect(m.code).toBe("invalid_transition");
    expect(m.message).toContain(task.status);
    expect(m.details).toMatchObject({
      entity: "task",
      taskId: task.id,
      from: task.status,
      event: ev,
    });
  });
});

describe("taskMachine.transition: attempts guards", () => {
  it.each([
    // attempt, maxAttempts, allowed
    [0, 3, true],
    [1, 3, true],
    [2, 3, false],
    [0, 1, false],
  ] as const)(
    "verification_failed at attempt %i of %i -> back to running=%s",
    (attempt, maxAttempts, ok) => {
      const task = makeTask({
        status: "verifying",
        attempt,
        maxAttempts,
        leaseExpiresAt: LEASE_AT,
      });
      const next = taskMachine.transition(task, EVENTS.verification_failed);
      if (ok) {
        expect(next.status).toBe("running");
        expect(next.attempt).toBe(attempt + 1);
        expect(next.leaseExpiresAt).toBe(LEASE_AT);
      } else {
        // no attempts left: the task fails for good instead of hanging in verifying
        expect(next.status).toBe("failed");
        expect(next.attempt).toBe(attempt);
        expect(next.leaseExpiresAt).toBeNull();
        expect(isTaskSettled(next)).toBe(true);
        expect(() => taskMachine.transition(next, EVENTS.retry)).toThrow(MimirError);
      }
    },
  );

  it.each([
    [0, 3, true],
    [2, 3, false],
    [0, 1, false],
  ] as const)("retry at attempt %i of %i -> allowed=%s", (attempt, maxAttempts, ok) => {
    const task = makeTask({ status: "failed", attempt, maxAttempts });
    if (ok) {
      const next = taskMachine.transition(task, EVENTS.retry);
      expect(next.status).toBe("ready");
      expect(next.attempt).toBe(attempt + 1);
    } else {
      expect(() => taskMachine.transition(task, EVENTS.retry)).toThrow(MimirError);
    }
  });
});

describe("taskMachine.transition: field effects", () => {
  it("lease_granted records crew and lease expiry", () => {
    const crewId = "crw_01J00000000000000000000000" as never;
    const next = taskMachine.transition(makeTask({ status: "ready" }), {
      type: "lease_granted",
      crewId,
      leaseExpiresAt: LEASE_AT,
    });
    expect(next.crewId).toBe(crewId);
    expect(next.leaseExpiresAt).toBe(LEASE_AT);
  });

  it("lease_granted with null crewId keeps the existing crew", () => {
    const crewId = "crw_01J00000000000000000000000" as never;
    const next = taskMachine.transition(
      makeTask({ status: "ready", crewId }),
      EVENTS.lease_granted,
    );
    expect(next.crewId).toBe(crewId);
  });

  it("session_started records the agent", () => {
    const agentId = "agt_01J00000000000000000000000" as never;
    const next = taskMachine.transition(makeTask({ status: "leased" }), {
      type: "session_started",
      agentId,
    });
    expect(next.agentId).toBe(agentId);
  });

  it.each(["completed", "failed", "cancelled", "ready"] as const)(
    "entering %s clears the lease",
    (to) => {
      const from = to === "completed" ? "verifying" : to === "ready" ? "failed" : "running";
      const ev =
        to === "completed"
          ? EVENTS.verification_passed
          : to === "ready"
            ? EVENTS.retry
            : to === "failed"
              ? EVENTS.runtime_failed
              : EVENTS.cancel;
      const next = taskMachine.transition(makeTask({ status: from, leaseExpiresAt: LEASE_AT }), ev);
      expect(next.status).toBe(to);
      expect(next.leaseExpiresAt).toBeNull();
    },
  );

  it("retry clears the agent", () => {
    const agentId = "agt_01J00000000000000000000000" as never;
    const next = taskMachine.transition(makeTask({ status: "failed", agentId }), EVENTS.retry);
    expect(next.agentId).toBeNull();
  });
});

describe("taskMachine.transition: blockedReason", () => {
  it.each([
    ["runtime_blocked", "needs input"],
    ["approval_needed", "push"],
  ] as const)("%s records the reason", (ev, reason) => {
    const next = taskMachine.transition(taskIn("running"), EVENTS[ev]);
    expect(next.blockedReason).toBe(reason);
  });

  it("budget_exceeded with reason budget_uncertain records budget_uncertain", () => {
    const next = taskMachine.transition(taskIn("ready"), {
      type: "budget_exceeded",
      reason: BUDGET_UNCERTAIN,
    });
    expect(next.blockedReason).toBe(BUDGET_UNCERTAIN);
    expect(isParked(next)).toBe(true);
  });

  it("recovery_unknown from a runtime-blocked task parks it unknown_after_restart", () => {
    const next = taskMachine.transition(taskIn("blocked"), EVENTS.recovery_unknown);
    expect(next.blockedReason).toBe(UNKNOWN_AFTER_RESTART);
  });

  it("budget_exceeded records budget_exceeded", () => {
    expect(taskMachine.transition(taskIn("ready"), EVENTS.budget_exceeded).blockedReason).toBe(
      BUDGET_EXCEEDED,
    );
  });

  it.each([
    ["blocked", "input_received"],
    ["blocked", "approval_granted"],
    ["blocked:budget", "budget_restored"],
    ["blocked:budget", "cancel"],
    ["blocked", "cancel"],
  ] as const)("leaving %s via %s clears blockedReason", (from, ev) => {
    const next = taskMachine.transition(taskIn(from), EVENTS[ev]);
    expect("blockedReason" in next).toBe(false);
  });

  it("budget and runtime blocks have separate exits", () => {
    expect(() => taskMachine.transition(taskIn("blocked"), EVENTS.budget_restored)).toThrow(
      /budget/,
    );
    expect(() => taskMachine.transition(taskIn("blocked:budget"), EVENTS.input_received)).toThrow(
      /budget/,
    );
  });
});

describe("taskMachine.transition: parked blocks (T12)", () => {
  it.each([APPROVAL_REQUIRED, POLICY_DENIED] as const)(
    "dispatch_gated records %s and leaves no lease",
    (reason) => {
      const next = taskMachine.transition(taskIn("ready"), { type: "dispatch_gated", reason });
      expect(next.status).toBe("blocked");
      expect(next.blockedReason).toBe(reason);
      expect(next.leaseExpiresAt).toBeNull();
    },
  );

  it("dispatch_denied records policy_denied; dispatch_approved clears the reason", () => {
    expect(
      taskMachine.transition(taskIn("blocked:approval"), EVENTS.dispatch_denied).blockedReason,
    ).toBe(POLICY_DENIED);
    const ready = taskMachine.transition(taskIn("blocked:approval"), EVENTS.dispatch_approved);
    expect("blockedReason" in ready).toBe(false);
  });

  it("recovery_unknown records unknown_after_restart and keeps the lease", () => {
    const next = taskMachine.transition(
      taskIn("running", { leaseExpiresAt: LEASE_AT }),
      EVENTS.recovery_unknown,
    );
    expect(next.blockedReason).toBe(UNKNOWN_AFTER_RESTART);
    expect(next.leaseExpiresAt).toBe(LEASE_AT);
  });

  it("retry out of unknown_after_restart consumes an attempt and needs one left", () => {
    const next = taskMachine.transition(
      taskIn("blocked:unknown", { attempt: 0, maxAttempts: 3 }),
      EVENTS.retry,
    );
    expect(next.status).toBe("ready");
    expect(next.attempt).toBe(1);
    expect(next.agentId).toBeNull();
    expect(() =>
      taskMachine.transition(
        taskIn("blocked:unknown", { attempt: 2, maxAttempts: 3 }),
        EVENTS.retry,
      ),
    ).toThrow(MimirError);
  });

  it.each(["blocked:approval", "blocked:denied", "blocked:unknown"] as const)(
    "%s cannot be resumed by runtime input or a runtime approval",
    (state) => {
      expect(taskMachine.can(taskIn(state), "input_received")).toBe(false);
      expect(taskMachine.can(taskIn(state), "approval_granted")).toBe(false);
    },
  );
});

describe("helpers", () => {
  it("terminal statuses are completed and cancelled", () => {
    expect([...TASK_TERMINAL_STATUSES].sort()).toEqual(["cancelled", "completed"]);
  });

  it.each([
    [0, 3, true],
    [2, 3, false],
    [5, 3, false],
  ] as const)("attemptsLeft(attempt=%i,max=%i)=%s", (attempt, maxAttempts, want) => {
    expect(attemptsLeft(makeTask({ attempt, maxAttempts }))).toBe(want);
  });

  it.each([
    ["completed", 0, true],
    ["cancelled", 0, true],
    ["failed", 2, true],
    ["failed", 0, false],
    ["running", 2, false],
    ["pending", 0, false],
  ] as const)("isTaskSettled(%s, attempt=%i of 3)=%s", (status, attempt, want) => {
    expect(isTaskSettled(makeTask({ status, attempt, maxAttempts: 3 }))).toBe(want);
  });
});
