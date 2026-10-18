import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BROKKR_REPORT_KIND,
  evaluateEngineering,
  parseVerificationReport,
  type VerificationReport,
} from "./brokkr-report.js";
import { brokkrCheck, brokkrReport, HEAD_SHA, LOCK_DIGEST as LOCK } from "./fakes.js";

const task = {
  planTaskId: "implement-backend",
  mimirTaskId: "mt_impl",
  harnessLockDigest: LOCK,
  expectedCommit: HEAD_SHA,
};
/** The real fixture, bound to `task` as Mimir would bind it (task id, lock, commit). */
const own = (r: VerificationReport) => ({
  report: { ...r, taskId: "mt_impl" },
  target: {
    ...task,
    harnessLockDigest: r.harness.lockDigest,
    expectedCommit: r.repository.commitSha,
  },
});
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/brokkr-report.${name}.json`, import.meta.url), "utf8");

describe("Brokkr verification report", () => {
  it("uses the agreed artifact kind", () => {
    expect(BROKKR_REPORT_KIND).toBe("brokkr.verification-report");
  });

  describe("reports Brokkr itself emitted (fixtures/)", () => {
    it("parses the passed report and judges it passed against its own lock", () => {
      const parsed = parseVerificationReport(fixture("passed"));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.checks.map((c) => [c.id, c.state, c.exitCode])).toEqual([
        ["typecheck", "passed", 0],
        ["unit", "passed", 0],
      ]);
      const { report, target } = own(parsed.value);
      expect(evaluateEngineering(report, target)).toEqual([]);
    });

    it("parses the failed report and never overrides it", () => {
      const parsed = parseVerificationReport(fixture("failed"));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const { report, target } = own(parsed.value);
      expect(evaluateEngineering(report, target).map((f) => f.reason)).toEqual([
        "brokkr_verdict_failed",
      ]);
    });

    it("tolerates fields a newer Brokkr adds", () => {
      const raw = JSON.parse(fixture("passed")) as Record<string, unknown> & {
        checks: Record<string, unknown>[];
      };
      raw.futureField = { x: 1 };
      raw.checks[0]!.futureCheckField = true;
      expect(parseVerificationReport(JSON.stringify(raw)).ok).toBe(true);
    });
  });

  it("rejects malformed reports, including Sindri's old `status` check field", () => {
    expect(parseVerificationReport("{not json").ok).toBe(false);
    expect(
      parseVerificationReport(JSON.stringify({ ...brokkrReport(), verdict: "approved" })).ok,
    ).toBe(false);
    const old = { ...brokkrReport(), checks: [{ id: "unit", status: "passed", required: true }] };
    expect(parseVerificationReport(JSON.stringify(old)).ok).toBe(false);
  });

  it("passes only when Brokkr says passed and the lock matches", () => {
    expect(evaluateEngineering(brokkrReport(), task)).toEqual([]);
  });

  it.each(["failed", "incomplete", "blocked"] as const)(
    "never overrides a %s verdict",
    (verdict) => {
      const failures = evaluateEngineering(brokkrReport({ verdict }), task);
      expect(failures.map((f) => f.reason)).toContain(`brokkr_verdict_${verdict}`);
    },
  );

  it("rejects a report for another harness lock or another task", () => {
    const lock = evaluateEngineering(
      brokkrReport({
        harness: { name: "x", version: "1.0.0", lockDigest: `sha256:${"b".repeat(64)}` },
      }),
      task,
    );
    expect(lock.map((f) => f.reason)).toEqual(["harness_lock_mismatch"]);
    const other = evaluateEngineering(brokkrReport({ taskId: "mt_other" }), task);
    expect(other.map((f) => f.reason)).toEqual(["report_task_mismatch"]);
    // The plan task id is not unique across executions: only the Mimir task id binds (N4).
    const byPlanId = evaluateEngineering(brokkrReport({ taskId: task.planTaskId }), task);
    expect(byPlanId.map((f) => f.reason)).toEqual(["report_task_mismatch"]);
    const noTask = brokkrReport();
    delete noTask.taskId;
    expect(evaluateEngineering(noTask, task).map((f) => f.reason)).toEqual(["report_task_missing"]);
  });

  it("binds the report to the commit it verified", () => {
    const reasons = (expectedCommit: string | null) =>
      evaluateEngineering(brokkrReport(), { ...task, expectedCommit }).map((f) => f.reason);
    expect(reasons(HEAD_SHA.slice(0, 12))).toEqual([]);
    expect(reasons("f".repeat(40))).toEqual(["report_commit_mismatch"]);
    expect(reasons(null)).toEqual(["report_commit_unverifiable"]);
  });

  it("is stricter than an inconsistent passed verdict, never laxer", () => {
    const check = (state: "failed" | "skipped", extra: Record<string, unknown> = {}) =>
      brokkrCheck("unit", state, extra);
    const reasons = (r: ReturnType<typeof brokkrReport>) =>
      evaluateEngineering(r, task).map((f) => f.reason);
    expect(reasons(brokkrReport({ checks: [check("failed", { exitCode: 1 })] }))).toEqual([
      "inconsistent_report:unit",
    ]);
    expect(reasons(brokkrReport({ checks: [check("skipped")] }))).toEqual([
      "inconsistent_report:unit",
    ]);
    // Excused by Brokkr's applied exception, referenced either way Brokkr records it.
    const exception = {
      id: "exc_1",
      policy: "check:unit",
      scope: {},
      reason: "flaky runner",
      approvedBy: "jacob",
      approvedAt: "2026-10-14T00:00:00.000Z",
      expiresAt: "2026-10-21T00:00:00.000Z",
      evidence: [],
      appliedTo: { harnesses: ["backend-node@1.0.0"], checkId: "unit" },
    };
    expect(reasons(brokkrReport({ checks: [check("skipped")], exceptions: [exception] }))).toEqual(
      [],
    );
    expect(
      reasons(
        brokkrReport({
          checks: [check("skipped", { exceptionId: "exc_1" })],
          exceptions: [{ ...exception, appliedTo: { harnesses: [] } }],
        }),
      ),
    ).toEqual([]);
    // A check id in a stray `checkId` field (Sindri's old reading) does not excuse anything.
    expect(
      reasons(
        brokkrReport({
          checks: [check("skipped")],
          exceptions: [{ ...exception, checkId: "unit", appliedTo: { harnesses: [] } }],
        }),
      ),
    ).toEqual(["inconsistent_report:unit"]);
  });
});
