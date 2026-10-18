import { z } from "zod";

/**
 * Mimir records Brokkr's `VerificationReport` (Brokkr spec §10.2, `@brokkr/sdk`) as an artifact
 * of this kind in its `verifying` step. Sindri reads it; it never runs or re-judges checks itself.
 */
export const BROKKR_REPORT_KIND = "brokkr.verification-report";

export const BROKKR_VERDICTS = ["passed", "failed", "incomplete", "blocked"] as const;
export type BrokkrVerdict = (typeof BROKKR_VERDICTS)[number];

/** Brokkr `CHECK_STATES` (`@brokkr/core`). */
export const BROKKR_CHECK_STATES = [
  "passed",
  "failed",
  "errored",
  "skipped",
  "cancelled",
  "timed_out",
] as const;

/**
 * Consumer-side mirror of Brokkr's `VerificationReportSchema` (`brokkr/packages/core/src/report.ts`,
 * spec §10.2). Field names follow Brokkr exactly (`checks[].state`, `exceptions[].appliedTo`);
 * only what Sindri relies on is required, and every object is loose so fields a newer Brokkr adds
 * are tolerated. Replace with the `@brokkr/sdk` schema (tarball) when it ships. Tested against
 * real Brokkr output in `fixtures/`.
 */
const CheckResultSchema = z.looseObject({
  id: z.string().min(1),
  /** Brokkr always sets it; absent is treated as required (fail closed). */
  required: z.boolean().optional(),
  reason: z.string().optional(),
  state: z.enum(BROKKR_CHECK_STATES),
  command: z.array(z.string()).optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().min(0).optional(),
  exceptionId: z.string().optional(),
});

const AppliedExceptionSchema = z.looseObject({
  id: z.string().min(1),
  appliedTo: z.looseObject({ checkId: z.string().optional() }).optional(),
});

export const VerificationReportSchema = z.looseObject({
  schemaVersion: z.literal("1.0"),
  id: z.string().min(1),
  executionId: z.string().optional(),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  harness: z.looseObject({
    name: z.string().min(1),
    version: z.string().min(1),
    lockDigest: z.string().min(1),
  }),
  repository: z.looseObject({
    commitSha: z.string().min(1),
    workspaceId: z.string().optional(),
    dirtyTreeDigest: z.string().optional(),
  }),
  startedAt: z.string(),
  completedAt: z.string(),
  verdict: z.enum(BROKKR_VERDICTS),
  checks: z.array(CheckResultSchema),
  policyDecisions: z.array(z.unknown()),
  exceptions: z.array(AppliedExceptionSchema),
  evidence: z.array(z.unknown()),
  summary: z.looseObject({
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
    errored: z.number().int().min(0),
  }),
});
export type VerificationReport = z.infer<typeof VerificationReportSchema>;
export type BrokkrCheckResult = VerificationReport["checks"][number];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseVerificationReport(text: string): ParseResult<VerificationReport> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  const parsed = VerificationReportSchema.safeParse(raw);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: why };
  }
  return { ok: true, value: parsed.data };
}

export interface GateFailure {
  gateId: string;
  reason: string;
  /** Mimir event or artifact id backing the failure. */
  evidenceRef?: string;
}

export interface EngineeringTarget {
  planTaskId: string;
  /** The Mimir task the report artifact was recorded for. */
  mimirTaskId: string;
  harnessLockDigest: string;
  /** The `headSha` in Mimir's `changed-files` manifest for this verifying step; `null` if none. */
  expectedCommit: string | null;
}

/** Same commit when one sha is a prefix of the other (at least 7 hex chars). */
export function sameCommit(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (Math.min(x.length, y.length) < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

export const ENGINEERING_GATE_ID = "brokkr";

/**
 * Engineering correctness (Brokkr spec §14.3). A verdict other than `passed` is final: Sindri can
 * add failures (lock or task mismatch, a passed verdict contradicted by its own required checks)
 * but can never turn a Brokkr failure into a pass (D-012).
 */
export function evaluateEngineering(
  report: VerificationReport,
  target: EngineeringTarget,
  evidenceRef?: string,
): GateFailure[] {
  const fail = (reason: string): GateFailure => ({
    gateId: ENGINEERING_GATE_ID,
    reason,
    ...(evidenceRef ? { evidenceRef } : {}),
  });
  const failures: GateFailure[] = [];
  if (report.verdict !== "passed") failures.push(fail(`brokkr_verdict_${report.verdict}`));
  if (report.harness.lockDigest !== target.harnessLockDigest) {
    failures.push(fail("harness_lock_mismatch"));
  }
  if (report.taskId === undefined) failures.push(fail("report_task_missing"));
  else if (report.taskId !== target.mimirTaskId) {
    failures.push(fail("report_task_mismatch"));
  }
  if (target.expectedCommit === null) failures.push(fail("report_commit_unverifiable"));
  else if (!sameCommit(report.repository.commitSha, target.expectedCommit)) {
    failures.push(fail("report_commit_mismatch"));
  }
  if (report.verdict === "passed") {
    const exceptionIds = new Set(report.exceptions.map((e) => e.id));
    const exceptedChecks = new Set(
      report.exceptions.map((e) => e.appliedTo?.checkId).filter(Boolean),
    );
    for (const check of report.checks) {
      if (check.required === false || check.state === "passed") continue;
      const excused =
        exceptedChecks.has(check.id) ||
        (check.exceptionId !== undefined && exceptionIds.has(check.exceptionId));
      if (check.state === "skipped" && (excused || check.reason === "not_applicable")) continue;
      failures.push(fail(`inconsistent_report:${check.id}`));
    }
  }
  return failures;
}
