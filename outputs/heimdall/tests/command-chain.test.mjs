// One click from a draft: submit, approve, then plan (or start, or draft), in that order, with the
// approval factor on each Sindri step. A follow-on that fails leaves the approval confirmed.
import test from "node:test";
import assert from "node:assert/strict";
import { setup, stub, send } from "./support.mjs";
import { commandRoute } from "../apps/server/commands.mjs";

async function chained(
  t,
  { proposeFails = false, alreadySubmitted = false, start = false } = {},
) {
  const sindri = await stub(t, (req, res) => {
    if (req.url === "/v1/approval-session")
      return send(res, 200, {
        approvalSecret: "human-secret",
        expiresAt: null,
      });
    if (req.url === "/v1/specs/spc_1/submit")
      return alreadySubmitted
        ? send(res, 409, {
            error: {
              code: "invalid_state",
              message: "only drafts can be submitted (is review)",
            },
          })
        : send(res, 200, { spec: { id: "spc_1", status: "review" } });
    if (req.url === "/v1/specs/spc_1/approve")
      return send(res, 200, { spec: { id: "spc_1", status: "approved" } });
    if (req.url === "/v1/plans/propose")
      return proposeFails
        ? send(res, 422, {
            error: { code: "validation_failed", message: "planner refused" },
          })
        : send(res, 201, { plan: { id: "pln_1", status: "draft" } });
    if (req.url === "/v1/plans/pln_1/submit")
      return send(res, 409, {
        error: { code: "invalid_state", message: "only drafts can be submitted" },
      });
    if (req.url === "/v1/plans/pln_1/approve")
      return send(res, 200, { plan: { id: "pln_1", status: "approved" } });
    if (req.url === "/v1/executions")
      return send(res, 201, { execution: { id: "exe_9", status: "running" } });
    send(res, 200, {});
  });
  const { call, operator } = await setup(t, {
    env: { SINDRI_URL: sindri.url, SINDRI_TOKEN: "stub-token" },
  });
  await operator();
  const answer = await call(
    "commands",
    {
      action: "spec.approve",
      id: "spc_1",
      reason: "Approve the spec",
      body: { submitFirst: true, thenPropose: true, ...(start ? { thenStart: true } : {}) },
    },
    { "idempotency-key": "chain-key-0000000001" },
  );
  const steps = sindri.requests.filter(
    (r) => r.method === "POST" && r.path !== "/v1/approval-session",
  );
  return { answer, json: await answer.json(), steps };
}

test("a chained approval submits, approves and proposes, each with the approval factor", async (t) => {
  const { answer, json, steps } = await chained(t);
  assert.equal(answer.status, 200);
  assert.deepEqual(
    steps.map((r) => r.path),
    ["/v1/specs/spc_1/submit", "/v1/specs/spc_1/approve", "/v1/plans/propose"],
  );
  assert.ok(
    steps.every((r) => r.headers["x-sindri-approval"] === "human-secret"),
  );
  // Each step has its own idempotency key, so a resend repeats none of them twice.
  assert.equal(new Set(steps.map((r) => r.headers["idempotency-key"])).size, 3);
  assert.deepEqual(JSON.parse(steps[2].body), { specId: "spc_1" });
  // The chain flags never reach Sindri.
  assert.deepEqual(JSON.parse(steps[1].body), {});
  assert.equal(json.result.plan.id, "pln_1");
  assert.equal(json.followUp, undefined);
});

test("a revision's spec is approved, planned and started in one click", async (t) => {
  const { answer, json, steps } = await chained(t, { start: true });
  assert.equal(answer.status, 200);
  assert.deepEqual(
    steps.map((r) => r.path),
    [
      "/v1/specs/spc_1/submit",
      "/v1/specs/spc_1/approve",
      "/v1/plans/propose",
      "/v1/plans/pln_1/submit",
      "/v1/plans/pln_1/approve",
      "/v1/executions",
    ],
  );
  assert.ok(steps.every((r) => r.headers["x-sindri-approval"] === "human-secret"));
  assert.equal(new Set(steps.map((r) => r.headers["idempotency-key"])).size, 6);
  assert.deepEqual(JSON.parse(steps[5].body), { planId: "pln_1" });
  // The plan's submit was already done (409): not a failure.
  assert.equal(json.followUp, undefined);
  assert.equal(json.result.execution.id, "exe_9");
});

test("a spec already in review is approved anyway: the submit step is skipped", async (t) => {
  const { answer, steps } = await chained(t, { alreadySubmitted: true });
  assert.equal(answer.status, 200);
  assert.equal(steps.at(-1).path, "/v1/plans/propose");
});

test("a failed follow-on keeps the approval confirmed and says what is left", async (t) => {
  const { answer, json } = await chained(t, { proposeFails: true });
  assert.equal(answer.status, 200);
  assert.equal(json.confirmed, true);
  assert.equal(json.result.spec.status, "approved");
  assert.deepEqual(json.followUp, {
    action: "plan.propose",
    message: "planner refused",
  });
});

test("a restart goes to Sindri's restart with the dialog's reason, nothing else", () => {
  const route = commandRoute({
    action: "execution.restart",
    id: "exe_1",
    reason: "Claude's limit reset",
    body: { stray: 1 },
  });
  assert.equal(route.path, "/v1/executions/exe_1/restart");
  assert.deepEqual(route.body, { reason: "Claude's limit reset" });
});

test("a remove goes to Sindri's remove with the dialog's reason, nothing else", () => {
  const route = commandRoute({
    action: "execution.remove",
    id: "exe_1",
    reason: "Duplicate of a later run",
    body: { stray: 1 },
  });
  assert.equal(route.source, "sindri");
  assert.equal(route.path, "/v1/executions/exe_1/remove");
  assert.deepEqual(route.body, { reason: "Duplicate of a later run" });
  assert.throws(() =>
    commandRoute({ action: "execution.remove", id: "../x", reason: "r" }),
  );
});

test("a restore goes to Sindri's restore with the dialog's reason, nothing else", () => {
  const route = commandRoute({
    action: "execution.restore",
    id: "exe_1",
    reason: "Restore run",
    body: { stray: 1 },
  });
  assert.equal(route.path, "/v1/executions/exe_1/restore");
  assert.deepEqual(route.body, { reason: "Restore run" });
});
