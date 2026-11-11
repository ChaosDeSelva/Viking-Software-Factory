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
});

test("a delivery is titled by its specification rather than its execution ID", () => {
  const executions = [{ execution: { id: "exe_1" }, plan: { id: "pln_1", specId: "spc_1" } }];
  const specs = [{ id: "spc_1", title: "Exact invoice totals" }];
  assert.equal(deliveryTitle({ id: "exe_1" }, executions, specs), "Exact invoice totals");
  assert.equal(deliveryTitle({ id: "exe_2" }, executions, specs), undefined);
});
