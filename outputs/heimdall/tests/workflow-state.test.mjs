import { test } from "node:test";
import assert from "node:assert/strict";
import {
  latestVersions,
  orderedQuestions,
  statusBadge,
  actionBlock,
  specRevision,
  mergeEventPages,
  projectKey,
  mergeProjects,
  projectAliases,
  deliveryTitle,
  intakeRequest,
  recordLabel,
  runTitle,
  missionSpecTitle,
} from "../apps/web/src/features/workflowState.ts";

test("only the highest version of each lineage is listed", () => {
  const rows = [
    { id: "s1", lineageId: "a", version: 1, status: "superseded" },
    { id: "s3", lineageId: "a", version: 3, status: "draft" },
    { id: "s2", lineageId: "a", version: 2, status: "approved" },
    { id: "t1", lineageId: "b", version: 1 },
    { id: "loose" },
  ];
  assert.deepEqual(latestVersions(rows).map((r) => r.id), ["s3", "t1", "loose"]);
});

test("open questions come from the specification, blocking first", () => {
  const spec = {
    body: {
      openQuestions: [
        { id: "q1", blocking: false },
        { id: "q2", blocking: true },
        { id: "q3", blocking: false },
        { id: "q4", blocking: true },
      ],
    },
  };
  assert.deepEqual(orderedQuestions(spec).map((q) => q.id), ["q2", "q4", "q1", "q3"]);
  assert.deepEqual(orderedQuestions({ body: {} }), []);
  assert.deepEqual(orderedQuestions(null), []);
});

test("an intake without tracker status reads received; statusless kinds get no badge", () => {
  assert.equal(statusBadge("intakes", { id: "i" }), "received");
  assert.equal(statusBadge("intakes", { status: "open" }), "open");
  for (const kind of ["projects", "collection", "gate"])
    assert.equal(statusBadge(kind, { id: "x" }), undefined);
  assert.equal(statusBadge("event", { type: "task.output" }), "task.output");
});

test("Sindri actions need the unlock, the pairing and a status the backend accepts", () => {
  const ready = { operator: true, pairedSindri: true };
  assert.match(actionBlock("spec.submit", "draft", {}), /Unlock/);
  assert.match(actionBlock("spec.submit", "draft", { operator: true }), /Pair/);
  assert.equal(actionBlock("spec.submit", "draft", ready), "");
  assert.match(actionBlock("spec.submit", "review", ready), /draft/);
  assert.equal(actionBlock("plan.approve", "review", ready), "");
  assert.match(actionBlock("plan.approve", "draft", ready), /review/);
  assert.match(actionBlock("spec.approve", "approved", ready), /status is approved/);
  assert.equal(actionBlock("execution.create", "approved", ready), "");
  assert.notEqual(actionBlock("execution.create", "review", ready), "");
  assert.equal(actionBlock("execution.export", "verified_pending_review", ready), "");
  assert.notEqual(actionBlock("execution.export", "running", ready), "");
  assert.equal(actionBlock("delivery.rework", undefined, ready), "");
  assert.match(actionBlock("plan.propose", undefined, ready), /status is not reported/);
});

test("a specification revision carries only the changed fields", () => {
  const spec = { title: "Totals", body: { problem: "Sums drift", goals: ["a", "b"] } };
  const same = { title: "Totals", problem: "Sums drift", goals: "a\nb" };
  assert.equal(specRevision(spec, same), null);
  assert.deepEqual(specRevision(spec, { ...same, title: "Exact totals" }), {
    title: "Exact totals",
  });
  assert.deepEqual(specRevision(spec, { ...same, goals: "a\n\nc" }), {
    body: { goals: ["a", "c"] },
  });
  assert.deepEqual(specRevision(spec, { ...same, problem: "New" }), {
    body: { problem: "New" },
  });
  // A body without goals reads as an empty list, so an empty goals box changes nothing.
  const bare = { title: "T", body: { problem: "P" } };
  assert.equal(specRevision(bare, { title: "T", problem: "P", goals: "" }), null);
  assert.deepEqual(specRevision(bare, { title: "T", problem: "P", goals: "g" }), {
    body: { goals: ["g"] },
  });
});

test("a refreshed first page keeps the older pages already loaded", () => {
  const loaded = [5, 4, 3, 2, 1].map((cacheSequence) => ({ cacheSequence }));
  const fresh = [7, 6, 5, 4].map((cacheSequence) => ({ cacheSequence }));
  assert.deepEqual(
    mergeEventPages(fresh, loaded).map((e) => e.cacheSequence),
    [7, 6, 5, 4, 3, 2, 1],
  );
});

test("a project keeps its filter key and archive state when Mimir takes it over", () => {
  const sindri = [{ id: "sp_1", name: "Invoices", repoPath: "/repo/invoice" }];
  const before = mergeProjects([], sindri);
  const after = mergeProjects([{ id: "prj_9", name: "invoice", repoPath: "/repo/invoice" }], sindri);
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "prj_9");
  assert.equal(after[0].name, "Invoices");
  assert.equal(projectKey(before[0]), projectKey(after[0]));
  const archived = ["sp_1"];
  assert.ok(projectAliases(after[0], sindri).some((id) => archived.includes(id)));
  assert.deepEqual(projectAliases(after[0], sindri), ["prj_9", "sp_1"]);
  assert.equal(projectKey({ id: "prj_bare" }), "prj_bare");
  assert.deepEqual(projectAliases({ id: "prj_bare" }, [{ id: "sp_2" }]), ["prj_bare"]);
  // Mimir's own name stays when Sindri has no record of the repository, or Mimir has no path.
  assert.deepEqual(
    mergeProjects([{ id: "prj_x", name: "x", repoPath: "/repo/x" }, { id: "prj_y", name: "y" }], sindri).map(
      (p) => [p.id, p.name],
    ),
    [["prj_x", "x"], ["prj_y", "y"], ["sp_1", "Invoices"]],
  );
});

test("a delivery is titled by its specification rather than its execution ID", () => {
  const executions = [{ execution: { id: "exe_1" }, plan: { id: "pln_1", specId: "spc_1" } }];
  const specs = [{ id: "spc_1", title: "Exact invoice totals" }];
  assert.equal(deliveryTitle({ id: "exe_1" }, executions, specs), "Exact invoice totals");
  assert.equal(deliveryTitle({ id: "exe_2" }, executions, specs), undefined);
  // A delivery row names its run by executionId; a plan unknown to the specs gives its own title.
  const planOnly = [{ execution: { id: "exe_3" }, plan: { specId: "spc_gone", title: "Plan title" } }];
  assert.equal(deliveryTitle({ id: "dlv", executionId: "exe_3" }, planOnly, specs), "Plan title");
});

test("an intake without a description is drafted from its title", () => {
  assert.equal(intakeRequest({ title: "Fix totals", body: "Use integer cents" }), "Use integer cents");
  // Sindri stores an empty body for a ticket without a description and refuses an empty request.
  assert.equal(intakeRequest({ title: "Fix totals", body: "" }), "Fix totals");
  assert.equal(intakeRequest({ title: "Fix totals", body: " \n " }), "Fix totals");
  assert.equal(intakeRequest({ title: "Fix totals" }), "Fix totals");
});

test("records are listed under the field their kind is named by", () => {
  assert.equal(recordLabel({ id: "t", title: "Title", objective: "o" }), "Title");
  assert.equal(recordLabel({ id: "m", objective: "Ship it" }), "Ship it");
  assert.equal(recordLabel({ id: "p", name: "Invoices" }), "Invoices");
  assert.equal(recordLabel({ id: "c", template: "Implementation crew" }), "Implementation crew");
  assert.equal(recordLabel({ id: "a", action: "runtime.command" }), "runtime.command");
  assert.equal(recordLabel({ id: "g", agentKind: "codex", role: "implementer" }), "codex · implementer");
  assert.equal(recordLabel({ id: "e", type: "task.output" }), "task.output");
  assert.equal(recordLabel({ id: "only-id" }), "only-id");
});

test("runs and missions are titled by the specification they deliver", () => {
  const specs = [{ id: "spc_1", title: "Exact invoice totals" }];
  const run = { execution: { id: "exe_1", mimirMissionId: "msn_1" }, plan: { specId: "spc_1", title: "Plan" } };
  assert.equal(runTitle(run, specs), "Exact invoice totals");
  assert.equal(runTitle({ ...run, plan: { specId: "spc_9", title: "Plan" } }, specs), "Plan");
  assert.equal(runTitle({ execution: { id: "exe_2" } }, specs), "Run exe_2");
  assert.equal(missionSpecTitle({ id: "msn_1" }, [run], specs), "Exact invoice totals");
  assert.equal(missionSpecTitle({ id: "msn_2" }, [run], specs), undefined);
});
