import { openDatabase } from "@sindri/knowledge";
import { describe, expect, it } from "vitest";
import { BROKKR_REPORT_KIND } from "./brokkr-report.js";
import {
  brokkrCheck,
  brokkrReport,
  FakeDeliveryWorld,
  BASE_SHA,
  changedFilesManifest,
  HEAD_SHA,
  planTaskView,
  planView,
} from "./fakes.js";
import {
  GateRunner,
  type GateSpec,
  type ReviewVerdictSource,
  type ReviewVerdictView,
} from "./gate-runner.js";

const IMPL = "implement-backend";

describe("structured review and final QA gates", () => {
  it.each([
    [
      "approved",
      {
        verdict: "approve",
        findings: [],
        acceptance: [{ criterionId: "AC-1", satisfied: true }],
        decisions: [],
      },
      true,
    ],
    [
      "changes requested",
      {
        verdict: "request_changes",
        findings: [],
        acceptance: [{ criterionId: "AC-1", satisfied: true }],
      },
      false,
    ],
    [
      "major finding",
      {
        verdict: "approve",
        findings: [{ severity: "major", message: "Missing docs" }],
        acceptance: [{ criterionId: "AC-1", satisfied: true }],
      },
      false,
    ],
    ["missing criterion", { verdict: "approve", findings: [], acceptance: [] }, false],
    [
      "failed criterion",
      { verdict: "approve", findings: [], acceptance: [{ criterionId: "AC-1", satisfied: false }] },
      false,
    ],
    [
      "invalid decisions",
      { verdict: "approve", findings: [], decisions: ["not an object"] },
      false,
    ],
  ])("%s", async (_name, reviewFile, passed) => {
    void _name;
    const w = world();
    report(w);
    w.artifact("mt_impl", "review", JSON.stringify(reviewFile));
    const result = await runner(w, [{ id: "qa-verdict", kind: "review-artifact" }]).evaluate(
      w.executionId,
      IMPL,
    );
    expect(result.passed).toBe(passed);
  });
  it("fails closed when no review artifact exists", async () => {
    const w = world();
    report(w);
    expect(
      reasons(
        await runner(w, [{ id: "qa-verdict", kind: "review-artifact" }]).evaluate(
          w.executionId,
          IMPL,
        ),
      ),
    ).toContain("review_missing");
  });
});

function world(opts: { maxRetries?: number } = {}) {
  const w = new FakeDeliveryWorld(
    planView([planTaskView(IMPL, { maxRetries: opts.maxRetries ?? 2 })]),
  );
  w.addTask(IMPL, "mt_impl", "crw_impl");
  w.event(
    "session.started",
    { runtime: "fake", runtimeRef: {} },
    { taskId: "mt_impl", sessionId: "ses_1" },
  );
  return w;
}

const report = (
  w: FakeDeliveryWorld,
  overrides: Parameters<typeof brokkrReport>[0] = {},
  opts: { manifestHead?: string | null } = {},
) => w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport(overrides)), opts);

function runner(w: FakeDeliveryWorld, gates: GateSpec[] = [], reviews?: ReviewVerdictSource) {
  return new GateRunner({
    db: openDatabase(":memory:"),
    executions: w,
    mimir: w,
    content: w,
    gatesFor: () => gates,
    ...(reviews ? { reviews } : {}),
    now: () => new Date("2026-10-14T12:00:00.000Z"),
  });
}

const review = (over: Partial<ReviewVerdictView> = {}): ReviewVerdictSource => ({
  latestFor: () => ({
    id: "rev_1",
    status: "completed",
    verdict: "approve",
    reason: null,
    acceptance: [{ criterionId: "AC-1", satisfied: true }],
    findings: [],
    reviewArtifactId: "art_review",
    implementerAttempt: 0,
    ...over,
  }),
});

const reasons = (r: { failures: { reason: string }[] }) => r.failures.map((f) => f.reason);
const run = (w: FakeDeliveryWorld, payload: Record<string, unknown>, refs = {}) =>
  w.event("test.run_completed", payload, { taskId: "mt_impl", ...refs });

describe("GateRunner.evaluate: engineering (Brokkr report)", () => {
  it("passes when Brokkr passed and every product gate has trusted evidence", async () => {
    const w = world();
    const reportId = report(w);
    run(w, { command: "pnpm test", passed: true, exitCode: 0, durationMs: 1200 });
    w.artifact("mt_impl", "screenshot", "png-bytes");
    const gates: GateSpec[] = [
      { id: "tests", kind: "command", command: "pnpm test" },
      { id: "shots", kind: "artifact", artifactKind: "screenshot" },
      { id: "review", kind: "review" },
    ];
    expect(await runner(w, gates, review()).evaluate(w.executionId, IMPL)).toMatchObject({
      passed: true,
      failures: [],
      engineering: { verdict: "passed", reportArtifactId: reportId },
    });
  });

  it("fails closed without a report", async () => {
    expect(reasons(await runner(world()).evaluate("exe_1", IMPL))).toEqual([
      "verification_report_missing",
    ]);
  });

  it("never overrides a failing Brokkr verdict", async () => {
    const w = world();
    const id = report(w, { verdict: "failed" });
    const result = await runner(w, [{ id: "review", kind: "review" }], review()).evaluate(
      w.executionId,
      IMPL,
    );
    expect(result.failures).toEqual([
      { gateId: "brokkr", reason: "brokkr_verdict_failed", evidenceRef: id },
    ]);
  });

  it("rejects tampered bytes and unparseable reports", async () => {
    const w = world();
    w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
      hash: `sha256:${"0".repeat(64)}`,
    });
    expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
      "evidence_integrity_mismatch",
    ]);
    const v = world();
    v.artifact("mt_impl", BROKKR_REPORT_KIND, "{ nope");
    expect(reasons(await runner(v).evaluate(v.executionId, IMPL))).toEqual([
      "verification_report_invalid",
    ]);
  });

  it("uses the latest report after a retry", async () => {
    const w = world();
    report(w, { verdict: "failed" });
    report(w, { id: "run_2" });
    expect((await runner(w).evaluate(w.executionId, IMPL)).passed).toBe(true);
  });

  describe("binding to the task (audit M2)", () => {
    it("ignores a report whose envelope task differs from its payload task", async () => {
      const w = world();
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
        envelopeTaskId: "mt_other",
      });
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "verification_report_missing",
      ]);
    });

    it("ignores reports from an untrusted source or with summarized provenance", async () => {
      const w = world();
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
        source: "agent:claude",
      });
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
        provenance: "summarized",
      });
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), { source: null });
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "verification_report_missing",
      ]);
    });

    it("requires the report to be recorded after the task entered verifying", async () => {
      const w = world();
      const id = `art_forged`;
      // Recorded without a preceding task.verifying (no verification ran).
      w.artifacts.set(id, {
        id,
        taskId: "mt_impl",
        kind: BROKKR_REPORT_KIND,
        uri: "x",
        hash: `sha256:${"0".repeat(64)}`,
      });
      w.event(
        "artifact.recorded",
        { artifactId: id, taskId: "mt_impl", kind: BROKKR_REPORT_KIND, uri: "x", hash: "h" },
        { taskId: "mt_impl", provenance: "derived" },
      );
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "verification_report_missing",
      ]);
    });

    it("rejects an artifact Mimir attributes to another task or kind", async () => {
      const w = world();
      const id = report(w);
      w.artifacts.set(id, { ...w.artifacts.get(id)!, taskId: "mt_other" });
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual(["artifact_mismatch"]);
    });

    it("requires report.taskId", async () => {
      const w = world();
      const noTask = brokkrReport();
      delete noTask.taskId;
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(noTask));
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "report_task_missing",
      ]);
    });

    it("binds the report to the head in Mimir's changed-files manifest, never to the worktree base", async () => {
      const w = world();
      // Mimir's worktree base differs from the head the agent committed to.
      w.event(
        "git.worktree_created",
        { worktreeId: "wt", path: "/w", branch: "b", baseSha: BASE_SHA },
        { taskId: "mt_impl" },
      );
      report(w);
      expect((await runner(w).evaluate(w.executionId, IMPL)).passed).toBe(true);

      // A report for the base commit is not the committed head: it must fail, not fall back.
      const base = world();
      base.event(
        "git.worktree_created",
        { worktreeId: "wt", path: "/w", branch: "b", baseSha: BASE_SHA },
        { taskId: "mt_impl" },
      );
      report(base, { repository: { commitSha: BASE_SHA } });
      expect(reasons(await runner(base).evaluate(base.executionId, IMPL))).toEqual([
        "report_commit_mismatch",
      ]);
    });

    it("never emits or needs git.commit_observed", async () => {
      const w = world();
      report(w);
      expect(w.eventLog.map((e) => e.type)).not.toContain("git.commit_observed");
      expect((await runner(w).evaluate(w.executionId, IMPL)).passed).toBe(true);
    });

    it("accepts a report at the base when the agent committed nothing (manifest head = base)", async () => {
      const w = world();
      w.artifact(
        "mt_impl",
        BROKKR_REPORT_KIND,
        JSON.stringify(
          brokkrReport({
            repository: { commitSha: BASE_SHA },
          }),
        ),
        { manifestHead: BASE_SHA },
      );
      expect((await runner(w).evaluate(w.executionId, IMPL)).passed).toBe(true);
    });

    it("fails closed when Mimir recorded no manifest, even with a worktree base on record", async () => {
      const w = world();
      w.event(
        "git.worktree_created",
        { worktreeId: "wt", path: "/w", branch: "b", baseSha: HEAD_SHA },
        { taskId: "mt_impl" },
      );
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
        manifestHead: null,
      });
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "report_commit_unverifiable",
      ]);
    });

    it("ignores a manifest from an untrusted source or another task", async () => {
      const w = world();
      w.artifact("mt_impl", "changed-files", changedFilesManifest(HEAD_SHA), {
        source: "agent:claude",
      });
      w.artifact("mt_other", "changed-files", changedFilesManifest(HEAD_SHA));
      w.artifact("mt_impl", BROKKR_REPORT_KIND, JSON.stringify(brokkrReport()), {
        manifestHead: null,
      });
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "report_commit_unverifiable",
      ]);
    });

    it("rejects a manifest whose bytes do not match Mimir's hash", async () => {
      const w = world();
      w.artifact("mt_impl", "changed-files", changedFilesManifest(HEAD_SHA), {
        hash: `sha256:${"0".repeat(64)}`,
      });
      report(w);
      expect(reasons(await runner(w).evaluate(w.executionId, IMPL))).toEqual([
        "evidence_integrity_mismatch",
        "report_commit_unverifiable",
      ]);
    });

    it("uses the manifest of the latest verifying step", async () => {
      const w = world();
      report(
        w,
        { verdict: "failed", repository: { commitSha: BASE_SHA } },
        { manifestHead: BASE_SHA },
      );
      report(w); // second attempt: new manifest at HEAD_SHA
      expect((await runner(w).evaluate(w.executionId, IMPL)).passed).toBe(true);
    });
  });
});

describe("GateRunner.evaluate: product gates", () => {
  const gates: GateSpec[] = [{ id: "tests", kind: "command", command: "pnpm test" }];

  it("command gates are never satisfied by a model claim or a summary", async () => {
    const w = world();
    report(w, { checks: [brokkrCheck("typecheck")] });
    w.event(
      "session.output",
      { text: "pnpm test: all tests passed", redacted: false, lines: 1 },
      { taskId: "mt_impl" },
    );
    w.event(
      "summary.created",
      { scope: "task", text: "tests pass", sourceEventIds: [] },
      { taskId: "mt_impl", provenance: "summarized" },
    );
    run(w, { command: "pnpm test", passed: true, exitCode: 0 }, { provenance: "summarized" });
    run(w, { command: "pnpm test", passed: true, exitCode: 0 }, { source: "agent:claude" });
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).failures).toEqual([
      { gateId: "tests", reason: "command_not_run" },
    ]);
  });

  it("need a recorded exit code 0 for the same command on this task; the latest run wins", async () => {
    const w = world();
    report(w, { checks: [brokkrCheck("typecheck")] });
    run(w, { command: "pnpm test:unit", passed: true, exitCode: 0 });
    run(w, { command: "pnpm test", passed: true, exitCode: 0 }, { taskId: null });
    run(w, { command: "pnpm test", passed: true, exitCode: 0 }, { taskId: "mt_other" });
    expect(reasons(await runner(w, gates).evaluate(w.executionId, IMPL))).toEqual([
      "command_not_run",
    ]);
    const noCode = run(w, { command: "pnpm test", passed: true });
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).failures).toEqual([
      { gateId: "tests", reason: "command_exit_code_unrecorded", evidenceRef: noCode },
    ]);
    run(w, { command: "pnpm test", passed: true, exitCode: 1 });
    expect(reasons(await runner(w, gates).evaluate(w.executionId, IMPL))).toEqual([
      "command_failed",
    ]);
    run(w, { command: "pnpm test", passed: true, exitCode: 0 });
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).passed).toBe(true);
  });

  it("are satisfied by a passed Brokkr check with that command and exit code 0", async () => {
    const w = world();
    report(w); // unit check: ["pnpm", "test"], exit 0
    expect((await runner(w, gates).evaluate(w.executionId, IMPL)).passed).toBe(true);
    const f = world();
    report(f, { checks: [brokkrCheck("unit", "passed", { exitCode: null })] });
    expect(reasons(await runner(f, gates).evaluate(f.executionId, IMPL))).toEqual([
      "command_not_run",
    ]);
  });

  it("artifact gates need the kind, recorded by Mimir for this task, with a sha256", async () => {
    const w = world();
    report(w);
    const shots: GateSpec[] = [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }];
    expect(reasons(await runner(w, shots).evaluate(w.executionId, IMPL))).toEqual([
      "artifact_missing",
    ]);
    w.artifact("mt_impl", "screenshot", "png", { source: "agent:claude" });
    expect(reasons(await runner(w, shots).evaluate(w.executionId, IMPL))).toEqual([
      "artifact_missing",
    ]);
    w.artifact("mt_impl", "screenshot", "png", { hash: "md5:abc" });
    expect(reasons(await runner(w, shots).evaluate(w.executionId, IMPL))).toEqual([
      "artifact_hash_invalid",
    ]);
    w.artifact("mt_impl", "screenshot", "png");
    expect((await runner(w, shots).evaluate(w.executionId, IMPL)).passed).toBe(true);
  });

  describe("review gates", () => {
    const rg: GateSpec[] = [{ id: "review", kind: "review" }];
    const evaluate = async (src?: ReviewVerdictSource, attempts = 0) => {
      const w = world();
      w.execTasks[0]!.attempts = attempts;
      report(w);
      return runner(w, rg, src).evaluate(w.executionId, IMPL);
    };

    it("need a completed approving review", async () => {
      expect(reasons(await evaluate())).toEqual(["review_missing"]);
      expect(reasons(await evaluate(review({ status: "requested", verdict: null })))).toEqual([
        "review_pending",
      ]);
      expect(
        (await evaluate(review({ verdict: "request_changes", reason: "unparseable_review" })))
          .failures,
      ).toEqual([
        {
          gateId: "review",
          reason: "review_request_changes:unparseable_review",
          evidenceRef: "art_review",
        },
      ]);
      expect((await evaluate(review())).passed).toBe(true);
    });

    it("fail when criteria are unmet or not assessed at all (I7, audit M1)", async () => {
      expect(
        reasons(
          await evaluate(review({ acceptance: [{ criterionId: "AC-1", satisfied: false }] })),
        ),
      ).toEqual(["acceptance_not_met:AC-1"]);
      expect(reasons(await evaluate(review({ acceptance: [] })))).toEqual([
        "acceptance_unreviewed:AC-1",
      ]);
    });

    it("fail on a critical finding whatever the stated verdict (audit M1)", async () => {
      expect(
        reasons(
          await evaluate(review({ findings: [{ severity: "critical", message: "auth bypass" }] })),
        ),
      ).toEqual(["review_critical_finding"]);
      expect(
        reasons(
          await evaluate(review({ findings: [{ severity: "blocking", message: "data loss" }] })),
        ),
      ).toEqual(["review_critical_finding"]);
      // Ruling (Ssec2): a major finding blocks too.
      expect(
        reasons(await evaluate(review({ findings: [{ severity: "major", message: "naming" }] }))),
      ).toEqual(["review_major_finding"]);
      expect(
        (await evaluate(review({ findings: [{ severity: "minor", message: "naming" }] }))).passed,
      ).toBe(true);
    });

    it("fail on duplicate or unknown acceptance ids (review m1, m2)", async () => {
      expect(
        reasons(
          await evaluate(
            review({
              acceptance: [
                { criterionId: "AC-1", satisfied: false },
                { criterionId: "AC-1", satisfied: true },
              ],
            }),
          ),
        ),
      ).toEqual(["acceptance_duplicate:AC-1"]);
      expect(
        reasons(
          await evaluate(
            review({
              acceptance: [
                { criterionId: "AC-1", satisfied: true },
                { criterionId: "AC99", satisfied: true },
              ],
            }),
          ),
        ),
      ).toEqual(["acceptance_unknown:AC99"]);
    });

    it("fail an approve with no acceptance list on a task with criteria (audit M1)", async () => {
      const w = world();
      w.plan.tasks.find((t) => t.id === IMPL)!.acceptanceCriteria = ["AC1", "AC2"];
      report(w);
      const r = await runner(w, rg, review({ acceptance: [] })).evaluate(w.executionId, IMPL);
      expect(reasons(r)).toEqual(["acceptance_unreviewed:AC1"]);
      const partial = await runner(
        w,
        rg,
        review({ acceptance: [{ criterionId: "AC1", satisfied: true }] }),
      ).evaluate(w.executionId, IMPL);
      expect(reasons(partial)).toEqual(["acceptance_unreviewed:AC2"]);
    });

    it("treat an approval from before the latest repair or retry as stale (I6)", async () => {
      expect(reasons(await evaluate(review({ implementerAttempt: 0 }), 1))).toEqual([
        "review_stale",
      ]);
      expect((await evaluate(review({ implementerAttempt: 1 }), 1)).passed).toBe(true);
    });
  });

  it("reports optional gate failures as advisories", async () => {
    const w = world();
    report(w);
    const result = await runner(w, [
      { id: "shots", kind: "artifact", artifactKind: "screenshot", required: false },
    ]).evaluate(w.executionId, IMPL);
    expect(result.passed).toBe(true);
    expect(result.advisories).toEqual([{ gateId: "shots", reason: "artifact_missing" }]);
  });

  it("records every evaluation, with the project id", async () => {
    const w = world();
    const r = runner(w);
    await r.evaluate(w.executionId, IMPL);
    report(w);
    const second = await r.evaluate(w.executionId, IMPL);
    expect(r.latest(w.executionId, IMPL)).toEqual(second);
    expect(r.history(w.executionId, IMPL).map((e) => e.passed)).toEqual([false, true]);
  });

  it("throws for an unknown execution or task", async () => {
    const w = world();
    await expect(runner(w).evaluate("exe_nope", IMPL)).rejects.toThrow(/unknown execution/);
    await expect(runner(w).evaluate(w.executionId, "nope")).rejects.toThrow(/unknown plan task/);
  });
});

describe("GateRunner.enforce", () => {
  const failed = (w: FakeDeliveryWorld) => {
    w.setMissionTaskStatus("mt_impl", "failed");
    report(w, { verdict: "failed" });
  };

  it("retries a failed task with a repair instruction under the shared attempt key", async () => {
    const w = world();
    failed(w);
    const outcome = await runner(w).enforce(w.executionId, IMPL);
    expect(outcome).toMatchObject({ action: "retried", attempt: 1 });
    expect(w.execTasks[0]!.attempts).toBe(1);
    const instruction = w.calls.find((c) => c.method === "sendInstruction")!;
    expect(instruction.key).toBe("sindri:gate-repair:exe_1:implement-backend:1:instruction");
    expect(instruction.args[0]).toBe("ses_1");
    expect(w.calls.find((c) => c.method === "retry")).toMatchObject({
      args: ["mt_impl", expect.stringContaining("brokkr_verdict_failed")],
      key: "sindri:retry:mt_impl:1",
    });
  });

  it("shares the plan's retry budget with DeliveryLoop's runtime retries (I1)", async () => {
    const w = world({ maxRetries: 2 });
    w.execTasks[0]!.attempts = 1; // one runtime retry already spent by DeliveryLoop
    failed(w);
    const r = runner(w);
    expect(await r.enforce(w.executionId, IMPL)).toMatchObject({ action: "retried", attempt: 2 });
    expect((await r.enforce(w.executionId, IMPL)).action).toBe("exhausted");
    expect(w.calls.filter((c) => c.method === "retry").map((c) => c.key)).toEqual([
      "sindri:retry:mt_impl:2",
    ]);
    expect(w.execTasks[0]!.attempts).toBe(2);
  });

  it("does nothing for a passing task", async () => {
    const w = world();
    report(w);
    expect((await runner(w).enforce(w.executionId, IMPL)).action).toBe("none");
    expect(w.execTasks[0]!.attempts).toBe(0);
  });

  it("escalates blocked or incomplete verification without spending an attempt", async () => {
    const w = world();
    w.setMissionTaskStatus("mt_impl", "failed");
    report(w, { verdict: "blocked" });
    expect((await runner(w).enforce(w.executionId, IMPL)).action).toBe("escalated");
    expect(w.execTasks[0]!.attempts).toBe(0);
  });

  it("escalates when Mimir refuses the retry", async () => {
    const w = world();
    failed(w);
    w.failures.set("retry", new Error("invalid_transition: task is completed"));
    const r = runner(w);
    expect(await r.enforce(w.executionId, IMPL)).toMatchObject({
      action: "escalated",
      error: "invalid_transition: task is completed",
    });
    expect(r.repairs(w.executionId, IMPL)).toEqual([]);
  });

  describe("completed tasks failing product gates (I10)", () => {
    const productFail = () => {
      const w = world();
      report(w);
      return {
        w,
        r: runner(w, [{ id: "shots", kind: "artifact", artifactKind: "screenshot" }]),
      };
    };

    it("get a repair task in the implementer's crew while the mission is open", async () => {
      const { w, r } = productFail();
      const outcome = await r.enforce(w.executionId, IMPL);
      expect(outcome).toMatchObject({ action: "repair_task_created", attempt: 1 });
      const create = w.calls.find((c) => c.method === "createTask")!;
      expect(create.key).toBe("sindri:repair:exe_1:implement-backend:1");
      expect(create.args[0]).toMatchObject({
        missionId: w.missionId,
        crewId: "crw_impl",
        dependsOn: ["mt_impl"],
      });
      expect(String((create.args[0] as { instruction: string }).instruction)).toContain(
        "artifact_missing",
      );
      expect(w.calls.map((c) => c.method)).not.toContain("retry");
      // Evidence from the repair task now counts for the plan task.
      w.artifact(outcome.repairTaskId!, "screenshot", "png");
      w.artifact(
        outcome.repairTaskId!,
        BROKKR_REPORT_KIND,
        JSON.stringify(brokkrReport({ taskId: outcome.repairTaskId! })),
      );
      expect((await r.evaluate(w.executionId, IMPL)).passed).toBe(true);
    });

    it("escalate when the mission is closed, without spending an attempt", async () => {
      const { w, r } = productFail();
      w.missionStatus = "completed";
      expect((await r.enforce(w.executionId, IMPL)).action).toBe("escalated");
      expect(w.execTasks[0]!.attempts).toBe(0);
      expect(w.calls.map((c) => c.method)).not.toContain("createTask");
    });

    it("are bounded by the shared budget", async () => {
      const { w, r } = productFail();
      w.execTasks[0]!.attempts = 2;
      expect((await r.enforce(w.executionId, IMPL)).action).toBe("exhausted");
    });
  });
});
