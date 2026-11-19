import assert from "node:assert/strict";
import test from "node:test";
import { eventContext } from "../apps/web/src/features/events.ts";

test("activity explains the recorded outcome without guessing a task's current status", () => {
  const describe = (type, payload) => eventContext({ type, payload });
  assert.equal(
    describe("test.run_completed", {
      command: "npm test",
      passed: false,
      exitCode: 1,
    }),
    "Failed (exit 1) · npm test",
  );
  assert.match(
    describe("task.retried", { attempt: 2, deferred: "awaiting_capacity" }),
    /Attempt 2.*Waiting for a free worker/,
  );
  assert.match(
    describe("approval.decided", {
      actor: "operator",
      decision: "reject",
      reason: "Revise scope",
    }),
    /operator.*reject.*Revise scope/,
  );
  assert.match(
    describe("task.completed", { verificationSkipped: "document_deliverable" }),
    /document for review/,
  );
  assert.match(
    describe("mission.decision_log_requested", {}),
    /waiting for the coordinator/,
  );
  assert.match(
    describe("mission.decision_log_pinned", { decisionLogRef: null }),
    /no decision entries/,
  );
  assert.equal(describe("task.completed", {}), "");
  assert.equal(
    describe("new.event", { from: "pending", to: "active" }),
    "pending → active",
  );
  assert.equal(describe("new.event", { internal: "private detail" }), "");
});
