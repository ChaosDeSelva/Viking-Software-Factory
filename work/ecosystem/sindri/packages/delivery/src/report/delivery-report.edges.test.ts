import { FakeProvider, type FakeResponder } from "@sindri/director";
import { describe, expect, it } from "vitest";
import { BROKKR_REPORT_KIND } from "../gates/brokkr-report.js";
import {
  brokkrCheck,
  brokkrReport,
  changedFilesManifest,
  FakeDeliveryWorld,
  HEAD_SHA,
  planTaskView,
  planView,
} from "../gates/fakes.js";
import { sha256Of } from "../gates/evidence.js";
import type { GateResult } from "../gates/gate-runner.js";
import type { PrRequestResult } from "../gates/ports.js";
import type { ReviewRecord } from "../review/review-orchestrator.js";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import {
  CHANGED_FILES_KIND,
  DeliveryReports,
  renderPrDescription,
  type DeliveryReport,
} from "./delivery-report.js";
import { BASE_SHA, context, IMPL, SPEC } from "./scenario.test-helpers.js";

const DOCS = "write-docs";
const ORPHAN = "never-started";

/** A world with an implementer, a docs task and a plan task Mimir never got. */
function world(): FakeDeliveryWorld {
  const w = new FakeDeliveryWorld(
    planView(
      [
        planTaskView(IMPL, { acceptanceCriteria: ["AC-1", "AC-2"] }),
        planTaskView(DOCS, { role: "docs", acceptanceCriteria: [] }),
        planTaskView(ORPHAN, { acceptanceCriteria: [] }),
      ],
      { specId: SPEC.id, specVersion: SPEC.version },
    ),
  );
  w.addTask(IMPL, "mt_impl", "crw_impl");
  w.addTask(DOCS, "mt_docs", "crw_docs");
  return w;
}

function gate(planTaskId: string, extra: Partial<GateResult> = {}): GateResult {
  return {
    evaluationId: `gev_${planTaskId}`,
    executionId: "exe_1",
    planTaskId,
    mimirTaskId: `mt_${planTaskId}`,
    passed: true,
    engineering: null,
    failures: [],
    advisories: [],
    evaluatedAt: "2026-10-14T12:00:00.000Z",
    ...extra,
  };
}

function review(extra: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: "rev_1",
    executionId: "exe_1",
    planTaskId: IMPL,
    implementerTaskId: "mt_impl",
    implementerCrewId: "crw_impl",
    implementerAttempt: 0,
    reviewerCrewId: "crw_rev",
    reviewerTaskId: "mt_rev",
    role: "reviewer",
    origin: "created",
    status: "completed",
    verdict: "approve",
    reason: null,
    findings: [],
    acceptance: [],
    decisions: [],
    reviewArtifactId: null,
    requestedAt: "2026-10-14T12:00:00.000Z",
    completedAt: "2026-10-14T12:00:00.000Z",
    ...extra,
  };
}

function reportsFor(
  w: FakeDeliveryWorld,
  o: {
    gates?: Record<string, GateResult>;
    reviews?: ReviewRecord[];
    responder?: FakeResponder;
    prRoles?: readonly string[];
  } = {},
) {
  const provider = new FakeProvider(o.responder ?? (() => ({ text: "" })));
  const reports = new DeliveryReports({
    db: openDeliveryTestDb(),
    executions: w,
    mimir: w,
    content: w,
    context,
    provider,
    gates: { latest: (_e, planTaskId) => o.gates?.[planTaskId] },
    reviews: { list: () => o.reviews ?? [] },
    ...(o.prRoles ? { prRoles: o.prRoles } : {}),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  });
  return { reports, provider };
}

/** Records an artifact whose recorded hash matches `content`, as Mimir would. */
const consistent = (w: FakeDeliveryWorld, taskId: string, kind: string, content: string) =>
  w.artifact(taskId, kind, content, { hash: `sha256:${sha256Of(content)}`, manifestHead: null });

describe("DeliveryReports.build: evidence that cannot be used as recorded", () => {
  it("refuses an execution whose specification is gone", async () => {
    const w = world();
    w.plan = { ...w.plan, specId: "spc_gone" };
    const { reports } = reportsFor(w);
    await expect(reports.build(w.executionId)).rejects.toMatchObject({
      name: "DeliveryError",
      code: "unknown_spec",
      message: "unknown specification spc_gone",
    });
  });

  it("names Brokkr exceptions, unreadable reports and advisory gates as limitations", async () => {
    const w = world();
    const excepted = consistent(
      w,
      "mt_impl",
      BROKKR_REPORT_KIND,
      JSON.stringify(
        brokkrReport({
          exceptions: [{ id: "exc-1", appliedTo: { checkId: "unit" } }, { id: "exc-2" }],
          // Brokkr records no exit code for a check it did not run to completion.
          checks: [brokkrCheck("unit", "passed", { exitCode: undefined, required: undefined })],
        }),
      ),
    );
    const tampered = consistent(w, "mt_docs", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()));
    w.contents.set(tampered, "changed after recording");
    const invalid = consistent(w, "mt_docs", BROKKR_REPORT_KIND, '{"schemaVersion":"0.1"}');
    const { reports } = reportsFor(w, {
      gates: {
        [IMPL]: gate(IMPL, { engineering: { verdict: "passed", reportArtifactId: excepted } }),
        [DOCS]: gate(DOCS, {
          engineering: { verdict: "passed", reportArtifactId: tampered },
          advisories: [{ gateId: "lint", reason: "command_failed" }],
        }),
        [ORPHAN]: gate(ORPHAN, {
          passed: false,
          engineering: { verdict: "passed", reportArtifactId: invalid },
          failures: [{ gateId: "brokkr", reason: "brokkr_report_missing" }],
        }),
      },
    });
    const report = await reports.build(w.executionId);

    expect(report.limitations).toEqual(
      expect.arrayContaining([
        `${IMPL}: Brokkr approved exceptions for unit, exc-2`,
        `${DOCS}: Brokkr report could not be re-read for this report`,
        `${DOCS}: advisory gate lint: command_failed`,
        `${ORPHAN}: Brokkr report could not be re-read for this report`,
        `${ORPHAN}: quality gates not passed (brokkr: brokkr_report_missing)`,
      ]),
    );
    expect(report.tasks.find((t) => t.planTaskId === IMPL)?.brokkr).toMatchObject({
      reportArtifactId: excepted,
      checks: [{ id: "unit", state: "passed", required: true, exitCode: null }],
    });
    expect(report.tasks.find((t) => t.planTaskId === DOCS)?.brokkr).toBeNull();
    // A plan task Mimir never received has no Mimir task and an unknown status.
    expect(report.tasks.find((t) => t.planTaskId === ORPHAN)).toMatchObject({
      mimirTaskId: null,
      status: "unknown",
      gate: { passed: false },
    });
  });

  it("reads changed-file manifests of every shape and names those it cannot read", async () => {
    const w = world();
    consistent(
      w,
      "mt_impl",
      CHANGED_FILES_KIND,
      JSON.stringify(["a.ts", { path: "b.ts" }, { status: "added" }, 42, { path: 7 }]),
    );
    const noFiles = consistent(w, "mt_impl", CHANGED_FILES_KIND, '{"worktreeId":"wt_1"}');
    const notJson = consistent(w, "mt_impl", CHANGED_FILES_KIND, "not json");
    const tampered = consistent(w, "mt_impl", CHANGED_FILES_KIND, '["x.ts"]');
    w.contents.set(tampered, '["y.ts"]');
    consistent(
      w,
      "mt_docs",
      CHANGED_FILES_KIND,
      JSON.stringify({ headSha: 5, files: [{ path: "docs/c.md", status: "deleted" }] }),
    );
    const { reports } = reportsFor(w);
    const report = await reports.build(w.executionId);

    expect(
      report.changedFiles.map(({ planTaskId, path, status }) => ({ planTaskId, path, status })),
    ).toEqual([
      { planTaskId: IMPL, path: "a.ts", status: null },
      { planTaskId: IMPL, path: "b.ts", status: null },
      { planTaskId: DOCS, path: "docs/c.md", status: "deleted" },
    ]);
    for (const id of [noFiles, notJson, tampered]) {
      expect(report.limitations).toContain(`changed-file manifest ${id} could not be read`);
    }
    // A manifest without a usable head names no commit.
    expect(report.rollback.commits).toEqual([]);
  });

  it("builds rollback data only from complete, attributed git events and manifest heads", async () => {
    const w = world();
    w.event("git.worktree_created", "not an object", { taskId: "mt_impl" });
    w.event(
      "git.worktree_created",
      { branch: "mimir/mt_impl", baseSha: BASE_SHA },
      {
        taskId: "mt_impl",
      },
    );
    w.event(
      "git.worktree_created",
      { branch: "mimir/mt_ghost", baseSha: BASE_SHA, path: "/repo/.worktrees/mt_ghost" },
      { taskId: "mt_ghost" },
    );
    w.event(
      "git.worktree_created",
      { branch: "mimir/mt_impl", baseSha: BASE_SHA, path: "/repo/.worktrees/mt_impl" },
      { taskId: "mt_impl" },
    );
    const commit = w.event(
      "git.commit_observed",
      { sha: "c0ffee1", branch: "mimir/mt_impl", message: "Add compare" },
      { taskId: "mt_impl" },
    );
    w.event("git.commit_observed", { sha: "deadbee" }, { taskId: "mt_impl" });
    // The manifest records no base: its head is compared with the worktree's base.
    const manifest = consistent(
      w,
      "mt_impl",
      CHANGED_FILES_KIND,
      JSON.stringify({ headSha: HEAD_SHA, files: [] }),
    );
    // A head for a task without a worktree names no branch to roll back.
    consistent(w, "mt_docs", CHANGED_FILES_KIND, changedFilesManifest(HEAD_SHA));
    const { reports } = reportsFor(w);
    const report = await reports.build(w.executionId);

    expect(report.rollback.branches).toEqual([
      {
        planTaskId: IMPL,
        branch: "mimir/mt_impl",
        baseSha: BASE_SHA,
        worktreePath: "/repo/.worktrees/mt_impl",
      },
    ]);
    expect(report.rollback.commits).toEqual([
      { eventId: commit, planTaskId: IMPL, sha: "c0ffee1", branch: "mimir/mt_impl" },
      { eventId: manifest, planTaskId: IMPL, sha: HEAD_SHA, branch: "mimir/mt_impl" },
    ]);
  });
});

describe("DeliveryReports.build: implementation summary", () => {
  it("offers commits, task outcomes, unattributed runs and reviews as evidence", async () => {
    const w = world();
    w.event(
      "git.commit_observed",
      { sha: "c0ffee1", branch: "b1", message: "Add compare" },
      {
        taskId: "mt_impl",
      },
    );
    w.event("git.commit_observed", { sha: "deadbee", branch: "b1" }, { taskId: "mt_impl" });
    w.event("task.failed", { from: "running", to: "failed" }, { taskId: "mt_ghost" });
    w.event("task.completed", null, { taskId: "mt_docs" });
    w.event("test.run_completed", { command: "pnpm lint", passed: true }, { taskId: null });
    const { reports, provider } = reportsFor(w, {
      reviews: [
        review({ id: "rev_a", reviewArtifactId: null }),
        review({ id: "rev_b", verdict: "request_changes", reviewArtifactId: "art_rev" }),
        review({ id: "rev_c", status: "requested", verdict: null }),
      ],
      responder: (req) => {
        const id = / id="([^"]+)"/.exec(req.messages[0]!.content)![1]!;
        return { text: `Work was committed [ref:${id}]. Nothing else is known.` };
      },
    });
    const report = await reports.build(w.executionId);
    const prompt = provider.calls[0]!.messages[0]!.content;

    expect(prompt).toContain("Commit c0ffee1 on b1: Add compare");
    expect(prompt).toContain("Commit deadbee on b1: ");
    expect(prompt).toContain("Plan task (unknown) failed.");
    expect(prompt).toContain(`Plan task ${DOCS} completed.`);
    expect(prompt).toContain(
      'Test run for plan task (unattributed): command "pnpm lint", passed true.',
    );
    expect(prompt).toContain(
      `Independent reviewer review of plan task ${IMPL}: verdict request_changes. Findings: none.`,
    );
    expect(prompt).not.toContain("rev_a");
    expect(report.reviews.map((r) => r.reviewId)).toEqual(["rev_a", "rev_b"]);
    expect(report.summary.sentences).toHaveLength(1);
    expect(report.limitations).toEqual(
      expect.arrayContaining([
        "some test runs are not attributed to a task and satisfy no gate",
        `${IMPL}: independent review requested changes (findings)`,
        "1 summary sentence was removed: not backed by cited evidence",
      ]),
    );
  });

  it("asks no model when there is no evidence at all", async () => {
    const w = world();
    const { reports, provider } = reportsFor(w);
    const report = await reports.build(w.executionId);
    expect(provider.calls).toHaveLength(0);
    expect(report.summary).toEqual({ sentences: [], stripped: [] });
    expect(report.limitations).toContain("implementation summary unavailable (no evidence)");
    expect(report.requirements.map((r) => r.status)).toEqual(["unverified", "unverified"]);
  });

  it("reports an unexpected provider failure without its message", async () => {
    const w = world();
    w.event("task.completed", { from: "verifying", to: "completed" }, { taskId: "mt_impl" });
    const { reports } = reportsFor(w, {
      responder: () => {
        throw new Error("socket hang up: token=secret");
      },
    });
    const report = await reports.build(w.executionId);
    expect(report.limitations).toContain("implementation summary unavailable (error)");
    expect(report.limitations.join("\n")).not.toContain("secret");
  });
});

describe("DeliveryReports.requestPr: approvals and targets", () => {
  /** A world whose implementer committed and whose docs task has a worktree but no commit. */
  function deliverable() {
    const w = world();
    w.event(
      "git.worktree_created",
      { branch: "mimir/mt_impl", baseSha: BASE_SHA, path: "/wt/impl" },
      { taskId: "mt_impl" },
    );
    w.event(
      "git.worktree_created",
      { branch: "mimir/mt_docs", baseSha: BASE_SHA, path: "/wt/docs" },
      { taskId: "mt_docs" },
    );
    consistent(w, "mt_impl", CHANGED_FILES_KIND, changedFilesManifest(HEAD_SHA, [], BASE_SHA));
    const gates = { [IMPL]: gate(IMPL), [DOCS]: gate(DOCS), [ORPHAN]: gate(ORPHAN) };
    return { w, gates };
  }

  it("refuses an unknown execution", async () => {
    const { reports } = reportsFor(world());
    await expect(reports.requestPr("exe_nope")).rejects.toMatchObject({
      code: "unknown_execution",
    });
  });

  it("refuses when no delivering task has a worktree branch", async () => {
    const { w, gates } = deliverable();
    const { reports } = reportsFor(w, { gates, prRoles: ["qa"] });
    await expect(reports.requestPr(w.executionId)).rejects.toMatchObject({
      code: "nothing_to_deliver",
    });
    expect(w.calls.filter((c) => c.method === "requestPr")).toEqual([]);
  });

  it("stays built while a PR awaits approval, then asks again only for that PR", async () => {
    const { w, gates } = deliverable();
    const answers: Record<string, PrRequestResult[]> = {
      mt_impl: [{ status: "requested", approvalId: "apr_impl" }],
      mt_docs: [{ status: "awaiting_approval", approvalId: "apr_docs" }, { status: "requested" }],
    };
    w.requestPr = (mimirTaskId, input, key) => {
      w.calls.push({ method: "requestPr", args: [mimirTaskId, input], key });
      return Promise.resolve(answers[mimirTaskId]!.shift()!);
    };
    const { reports, provider } = reportsFor(w, { gates });

    const first = await reports.requestPr(w.executionId);
    expect(first).toEqual({
      deliveryId: expect.any(String),
      status: "built",
      prs: [
        {
          planTaskId: IMPL,
          mimirTaskId: "mt_impl",
          status: "requested",
          headSha: HEAD_SHA,
          approvalId: "apr_impl",
        },
        // No commit observed: the PR is for the worktree's base.
        {
          planTaskId: DOCS,
          mimirTaskId: "mt_docs",
          status: "awaiting_approval",
          headSha: BASE_SHA,
          approvalId: "apr_docs",
        },
      ],
    });
    expect(reports.prRequests(first.deliveryId)).toEqual(first.prs);
    expect(reports.get(first.deliveryId)?.status).toBe("built");
    const summaries = provider.calls.length;

    const second = await reports.requestPr(w.executionId);
    // The built report is reused, the requested PR is not asked for again.
    expect(second.deliveryId).toBe(first.deliveryId);
    expect(provider.calls).toHaveLength(summaries);
    expect(w.calls.filter((c) => c.method === "requestPr").map((c) => c.args[0])).toEqual([
      "mt_impl",
      "mt_docs",
      "mt_docs",
    ]);
    expect(second.status).toBe("delivered_pending_merge");
    expect(second.prs).toEqual([
      expect.objectContaining({ planTaskId: IMPL, status: "requested", approvalId: "apr_impl" }),
      { planTaskId: DOCS, mimirTaskId: "mt_docs", status: "requested", headSha: BASE_SHA },
    ]);
    expect(reports.latestFor(w.executionId)).toMatchObject({
      status: "delivered_pending_merge",
      deliveredAt: "2026-10-14T12:00:00.000Z",
    });
  });
});

describe("DeliveryReports.requestPr: a requested PR without an approval", () => {
  it("is reused as requested on the next request", async () => {
    const w = world();
    for (const t of ["mt_impl", "mt_docs"]) {
      w.event(
        "git.worktree_created",
        { branch: `b/${t}`, baseSha: BASE_SHA, path: `/wt/${t}` },
        {
          taskId: t,
        },
      );
    }
    const answers: Record<string, PrRequestResult[]> = {
      mt_impl: [{ status: "requested" }],
      mt_docs: [{ status: "awaiting_approval" }, { status: "requested" }],
    };
    w.requestPr = (mimirTaskId, input, key) => {
      w.calls.push({ method: "requestPr", args: [mimirTaskId, input], key });
      return Promise.resolve(answers[mimirTaskId]!.shift()!);
    };
    const gates = { [IMPL]: gate(IMPL), [DOCS]: gate(DOCS), [ORPHAN]: gate(ORPHAN) };
    const { reports } = reportsFor(w, { gates });
    const first = await reports.requestPr(w.executionId);
    expect(first.status).toBe("built");
    expect(reports.prRequests(first.deliveryId)).toEqual([
      { planTaskId: IMPL, mimirTaskId: "mt_impl", status: "requested", headSha: BASE_SHA },
      { planTaskId: DOCS, mimirTaskId: "mt_docs", status: "awaiting_approval", headSha: BASE_SHA },
    ]);
    const second = await reports.requestPr(w.executionId);
    expect(second.prs[0]).toEqual({
      planTaskId: IMPL,
      mimirTaskId: "mt_impl",
      status: "requested",
      headSha: BASE_SHA,
    });
    expect(w.calls.filter((c) => c.method === "requestPr")).toHaveLength(3);
  });
});

describe("renderPrDescription: sparse reports", () => {
  const empty: DeliveryReport = {
    id: "dlv_1",
    executionId: "exe_1",
    projectId: "prj_1",
    status: "built",
    createdAt: "2026-10-14T12:00:00.000Z",
    deliveredAt: null,
    spec: { id: "spc_1", lineageId: "spl_1", version: 1, title: "T", intakeId: null },
    plan: { id: "pln_1", version: 1 },
    missionId: "mis_1",
    requirements: [],
    tasks: [],
    summary: { sentences: [], stripped: [] },
    changedFiles: [],
    testResults: [],
    screenshots: [],
    reviews: [],
    limitations: [],
    rollback: { branches: [], commits: [], note: "Rollback note." },
  };

  it("says what is missing in every section", () => {
    const md = renderPrDescription(empty);
    for (const line of [
      "_No evidence-backed summary._",
      "_No recorded test runs._",
      "_No completed review._",
      "_None recorded._",
      "_No changed-file manifest recorded._",
      "_None identified from the evidence._",
      "Rollback note.",
    ]) {
      expect(md).toContain(line);
    }
  });

  it("renders tasks without verification, failed gates, unattributed runs and located findings", () => {
    const harness = { id: "h", version: "1", lockDigest: "d" };
    const md = renderPrDescription({
      ...empty,
      tasks: [
        {
          planTaskId: "a",
          mimirTaskId: null,
          role: "implementer",
          status: "unknown",
          harness,
          gate: null,
          brokkr: null,
        },
        {
          planTaskId: "b",
          mimirTaskId: "mt_b",
          role: "implementer",
          status: "failed",
          harness,
          gate: { evaluationId: "g", passed: false, failures: [], advisories: [] },
          brokkr: null,
        },
      ],
      testResults: [
        {
          eventId: "e",
          planTaskId: null,
          command: "pnpm test",
          passed: false,
          exitCode: null,
          durationMs: null,
        },
      ],
      reviews: [
        {
          reviewId: "r",
          planTaskId: "b",
          role: "qa",
          verdict: null,
          reason: "missing_review",
          findings: [
            { severity: "major", message: "No tests", file: "src/a.ts" },
            { severity: "info", message: "Fine" },
          ],
          reviewArtifactId: null,
        },
      ],
    });
    expect(md).toContain("| a | none | - | not evaluated |");
    expect(md).toContain("| b | none | - | failed |");
    expect(md).toContain("| - | `pnpm test` | false | - | - |");
    expect(md).toContain("- b (qa): **pending** (missing_review)");
    expect(md).toContain("  - [major] No tests (src/a.ts)");
    expect(md).toContain("  - [info] Fine");
  });
});
