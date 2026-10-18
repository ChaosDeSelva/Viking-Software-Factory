import { FakeProvider, type FakeResponder } from "@sindri/director";
import type { SqliteDatabase } from "@sindri/knowledge";
import { openDeliveryTestDb } from "../test-db.test-helpers.js";
import { BROKKR_REPORT_KIND } from "../gates/brokkr-report.js";
import {
  brokkrCheck,
  brokkrReport,
  FakeDeliveryWorld,
  changedFilesManifest,
  HEAD_SHA,
  planTaskView,
  planView,
} from "../gates/fakes.js";
import { GateRunner, type GateSpec } from "../gates/gate-runner.js";
import type { ContextReader, IntakeView, SpecView } from "../gates/ports.js";
import { REVIEW_ARTIFACT_KIND, ReviewOrchestrator } from "../review/review-orchestrator.js";
import { CHANGED_FILES_KIND, DeliveryReports } from "./delivery-report.js";

/** The implementer worktree's base commit. */
export const BASE_SHA = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const IMPL = "implement-backend";
export const QA = "qa";

export const SPEC: SpecView = {
  id: "spc_1",
  lineageId: "spl_1",
  version: 2,
  status: "approved",
  title: "Player comparison API",
  intakeId: "int_1",
  acceptanceCriteria: [
    { id: "AC-1", text: "GET /compare returns both players", verification: "test" },
    { id: "AC-2", text: "Unknown players give 404", verification: "test" },
  ],
};

export const INTAKE: IntakeView = {
  id: "int_1",
  source: "linear",
  externalId: "ENG-42",
  externalUrl: "https://linear.app/x/issue/ENG-42",
  title: "Compare two players",
};

export const context: ContextReader = {
  spec: (id) => Promise.resolve(id === SPEC.id ? SPEC : undefined),
  intake: (id) => Promise.resolve(id === INTAKE.id ? INTAKE : undefined),
};

export const GATES: GateSpec[] = [
  { id: "unit-tests", kind: "command", command: "pnpm test" },
  { id: "independent-review", kind: "review" },
];

/** Cites the first evidence id the prompt offers, plus one uncited and one invented sentence. */
export const citingResponder: FakeResponder = (req) => {
  const ids = [...req.messages[0]!.content.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
  return {
    text: [
      `The backend change passed Brokkr verification [ref:${ids[0]}].`,
      "It is the fastest comparison API in the industry.",
      "Coverage reached 100% [ref:evt_does_not_exist].",
    ].join(" "),
  };
};

export interface Scenario {
  w: FakeDeliveryWorld;
  db: SqliteDatabase;
  gates: GateRunner;
  reviews: ReviewOrchestrator;
  reports: DeliveryReports;
  provider: FakeProvider;
}

/**
 * A fully scripted delivery: an implementer task with worktree, commit, test run, Brokkr report,
 * screenshot and changed-file manifest; a QA task; an independent review that approves.
 */
export async function scenario(
  opts: { failingFirstRun?: boolean; responder?: FakeResponder } = {},
): Promise<Scenario> {
  const plan = planView(
    [
      planTaskView(IMPL, { acceptanceCriteria: ["AC-1", "AC-2"], maxRetries: 2 }),
      planTaskView(QA, {
        acceptanceCriteria: ["AC-1", "AC-2"],
        role: "qa",
        dependsOn: [IMPL],
        harnessId: "qa-regression",
      }),
    ],
    { specId: SPEC.id, specVersion: SPEC.version },
  );
  const w = new FakeDeliveryWorld(plan);
  w.addTask(IMPL, "mt_impl", "crw_impl");
  w.addTask(QA, "mt_qa", "crw_qa", { template: "qa" });
  w.crews.push({ id: "crw_rev", template: "reviewer" });

  w.event(
    "task.started",
    { from: "leased", to: "running" },
    { taskId: "mt_impl", sessionId: "ses_impl" },
  );
  w.event(
    "git.worktree_created",
    {
      worktreeId: "wt_1",
      path: "/repo/.worktrees/mt_impl",
      branch: "mimir/mt_impl",
      baseSha: BASE_SHA,
    },
    { taskId: "mt_impl" },
  );
  if (opts.failingFirstRun) {
    // Brokkr failed in Mimir's verifying step with no attempts left: the task is failed.
    w.setMissionTaskStatus("mt_impl", "failed");
    w.execTasks[0]!.status = "failed";
    w.event(
      "test.run_completed",
      { command: "pnpm test", passed: false, total: 12, failed: 1, durationMs: 900, exitCode: 1 },
      {
        taskId: "mt_impl",
        sessionId: "ses_impl",
      },
    );
    w.artifact(
      "mt_impl",
      BROKKR_REPORT_KIND,
      JSON.stringify(
        brokkrReport({
          id: "run_fail",
          verdict: "failed",
          checks: [brokkrCheck("unit", "failed")],
        }),
      ),
    );
  } else {
    passingRun(w);
  }
  w.event(
    "git.worktree_created",
    {
      worktreeId: "wt_2",
      path: "/repo/.worktrees/mt_qa",
      branch: "mimir/mt_qa",
      baseSha: HEAD_SHA,
    },
    { taskId: "mt_qa" },
  );
  // QA committed nothing: Mimir's manifest head equals its worktree base.
  w.artifact("mt_qa", CHANGED_FILES_KIND, changedFilesManifest(HEAD_SHA, [], HEAD_SHA));
  w.artifact(
    "mt_qa",
    BROKKR_REPORT_KIND,
    JSON.stringify(brokkrReport({ id: "run_qa", taskId: "mt_qa" })),
    { manifestHead: null },
  );
  w.event("task.completed", { from: "verifying", to: "completed" }, { taskId: "mt_qa" });

  const db = openDeliveryTestDb();
  const now = () => new Date("2026-10-14T12:00:00.000Z");
  const reviews = new ReviewOrchestrator({ db, executions: w, mimir: w, content: w, now });
  const gates = new GateRunner({
    db,
    executions: w,
    mimir: w,
    content: w,
    reviews,
    gatesFor: (t) => (t.role === "implementer" ? GATES : []),
    now,
  });
  const provider = new FakeProvider(opts.responder ?? citingResponder);
  const reports = new DeliveryReports({
    db,
    executions: w,
    mimir: w,
    content: w,
    context,
    provider,
    gates,
    reviews,
    now,
  });
  return { w, db, gates, reviews, reports, provider };
}

/** What Mimir records when the implementer's (re)run passes. */
export function passingRun(w: FakeDeliveryWorld): void {
  w.setMissionTaskStatus("mt_impl", "completed");
  const t = w.execTasks.find((x) => x.mimirTaskId === "mt_impl");
  if (t) t.status = "completed";
  w.event(
    "test.run_completed",
    { command: "pnpm test", passed: true, total: 12, failed: 0, durationMs: 1500, exitCode: 0 },
    {
      taskId: "mt_impl",
      sessionId: "ses_impl",
    },
  );
  // Mimir's verifying step records the manifest (with the committed head) before the report.
  w.artifact(
    "mt_impl",
    CHANGED_FILES_KIND,
    changedFilesManifest(
      HEAD_SHA,
      [
        { path: "src/compare.ts", status: "added" },
        { path: "src/routes.ts", status: "modified" },
      ],
      BASE_SHA,
    ),
  );
  w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport({ id: "run_pass" })));
  w.artifact("mt_impl", "screenshot-desktop", "png-desktop");
  w.event("task.completed", { from: "verifying", to: "completed" }, { taskId: "mt_impl" });
}

/** Requests and completes an approving independent review of the implementer task. */
export async function approveReview(s: Scenario): Promise<void> {
  const review = await s.reviews.requestReview(s.w.executionId, IMPL);
  s.w.artifact(
    review.reviewerTaskId,
    REVIEW_ARTIFACT_KIND,
    JSON.stringify({
      verdict: "approve",
      findings: [
        { severity: "minor", message: "Rename cmp to compare", file: "src/compare.ts", line: 4 },
      ],
      acceptance: [
        { criterionId: "AC-1", satisfied: true },
        { criterionId: "AC-2", satisfied: true },
      ],
      decisions: [
        {
          title: "Compare endpoint is read-only",
          context: "Clients poll it",
          decision: "GET /compare never writes",
        },
      ],
    }),
  );
  await s.reviews.collect(review.id);
}

export const openTestDb = () => openDeliveryTestDb();
