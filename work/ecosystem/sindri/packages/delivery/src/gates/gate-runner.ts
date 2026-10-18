import { randomUUID } from "node:crypto";
import { ReviewFileSchema, BLOCKING_SEVERITIES } from "../review/review-orchestrator.js";
import { ensureQualitySchema } from "../schema.js";
import type { SqliteDatabase } from "@sindri/knowledge";
import {
  BROKKR_REPORT_KIND,
  ENGINEERING_GATE_ID,
  evaluateEngineering,
  parseVerificationReport,
  type BrokkrVerdict,
  type GateFailure,
  type VerificationReport,
} from "./brokkr-report.js";
import {
  evidenceTrust,
  isTrusted,
  latestSession,
  manifestHead,
  manifestOfVerifyingStep,
  readVerifiedArtifact,
  recordedArtifacts,
  sha256Hex,
  testRuns,
  type EvidenceTrust,
  type RecordedArtifact,
} from "./evidence.js";
import type {
  ArtifactContentReader,
  ExecutionEventView,
  ExecutionReader,
  ExecutionTaskView,
  ExecutionView,
  MimirActions,
  PlanTaskView,
} from "./ports.js";

/**
 * Product gates Sindri checks on top of Brokkr's engineering verdict. Each is satisfied only by
 * evidence Mimir recorded (trusted source, envelope-attributed), never by agent text.
 */
export type GateSpec =
  /**
   * A `test.run_completed` event (provenance `observed`) of this task with the same command and a
   * recorded exit code 0, or a passed check in the task's Brokkr report with that command and
   * exit code 0.
   */
  | { id: string; kind: "command"; command: string; required?: boolean }
  /** An artifact of this kind that Mimir records for this task, with a sha256. */
  | { id: string; kind: "artifact"; artifactKind: string; required?: boolean }
  /** This review/QA task's own structured verdict, verified against its assigned criteria. */
  | { id: string; kind: "review-artifact"; required?: boolean }
  /** A fresh, completed independent review that approves and assesses every criterion. */
  | { id: string; kind: "review"; required?: boolean };

/** What the review gate needs to know about the latest review of a task. */
export interface ReviewVerdictView {
  id: string;
  status: "requested" | "completed";
  verdict: "approve" | "request_changes" | null;
  reason: string | null;
  acceptance: { criterionId: string; satisfied: boolean }[];
  findings: { severity: string; message: string }[];
  reviewArtifactId: string | null;
  /** The implementer task's shared attempt counter when the review was requested. */
  implementerAttempt: number;
}

export interface ReviewVerdictSource {
  latestFor(executionId: string, planTaskId: string): ReviewVerdictView | undefined;
}

export interface GateResult {
  evaluationId: string;
  executionId: string;
  planTaskId: string;
  mimirTaskId: string;
  passed: boolean;
  /** Brokkr's verdict as recorded; `null` when no valid report was found. */
  engineering: { verdict: BrokkrVerdict; reportArtifactId: string } | null;
  failures: GateFailure[];
  /** Failures of optional gates: reported, never blocking. */
  advisories: GateFailure[];
  evaluatedAt: string;
}

export type EnforceAction =
  "none" | "retried" | "repair_task_created" | "pending" | "exhausted" | "escalated";

export interface EnforceOutcome {
  action: EnforceAction;
  result: GateResult;
  /** The shared attempt number spent, when `action` is `retried` or `repair_task_created`. */
  attempt?: number;
  /** The Mimir task created for the repair. */
  repairTaskId?: string;
  /** Why Mimir refused the repair, when `action` is `escalated` for that reason. */
  error?: string;
}

export interface GateRunnerOptions {
  db: SqliteDatabase;
  executions: ExecutionReader;
  mimir: MimirActions;
  content: ArtifactContentReader;
  /** Product gates per plan task. Default: none (engineering only). */
  gatesFor?: (task: PlanTaskView) => GateSpec[];
  reviews?: ReviewVerdictSource;
  /** Envelope sources accepted as evidence. Default `["mimir.server"]`. */
  trustedSources?: readonly string[];
  now?: () => Date;
}

export class GateError extends Error {
  override readonly name = "GateError";
}

interface EvaluationRow {
  id: string;
  execution_id: string;
  project_id: string;
  plan_task_id: string;
  mimir_task_id: string;
  passed: number;
  engineering_verdict: BrokkrVerdict | null;
  report_artifact_id: string | null;
  failures_json: string;
  advisories_json: string;
  evaluated_at: string;
}

const toResult = (r: EvaluationRow): GateResult => ({
  evaluationId: r.id,
  executionId: r.execution_id,
  planTaskId: r.plan_task_id,
  mimirTaskId: r.mimir_task_id,
  passed: r.passed === 1,
  engineering:
    r.engineering_verdict && r.report_artifact_id
      ? { verdict: r.engineering_verdict, reportArtifactId: r.report_artifact_id }
      : null,
  failures: JSON.parse(r.failures_json) as GateFailure[],
  advisories: JSON.parse(r.advisories_json) as GateFailure[],
  evaluatedAt: r.evaluated_at,
});

/** Keeps only characters that are safe to echo into an agent instruction. */
const safe = (s: string) => s.replace(/[^\w.:@/-]/g, "_").slice(0, 200);

export function repairInstruction(
  task: PlanTaskView,
  failures: GateFailure[],
  attempt: number,
): string {
  const lines = failures.map(
    (f) =>
      `- gate ${safe(f.gateId)}: ${safe(f.reason)}${f.evidenceRef ? ` (evidence ${safe(f.evidenceRef)})` : ""}`,
  );
  return [
    `Sindri quality gates failed for plan task ${safe(task.id)} (attempt ${attempt} of ${task.maxRetries}).`,
    "Fix the causes below, then let Mimir re-run verification. Claims in your output do not satisfy a gate; only recorded test runs, artifacts and Brokkr's report do.",
    ...lines,
  ].join("\n");
}

const TERMINAL_MISSION = new Set(["completed", "cancelled", "failed"]);

interface Context {
  execution: ExecutionView;
  planTask: PlanTaskView;
  execTask: ExecutionTaskView;
  /** The plan task's Mimir task, then any repair tasks, in creation order. */
  lineage: string[];
}

export class GateRunner {
  readonly #db: SqliteDatabase;
  readonly #o: GateRunnerOptions;
  readonly #now: () => Date;
  readonly #trust: EvidenceTrust;

  constructor(options: GateRunnerOptions) {
    this.#o = options;
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#trust = evidenceTrust(options.trustedSources);
    ensureQualitySchema(this.#db);
  }

  /** Engineering (Brokkr report) first, then product gates. Records the evaluation. */
  async evaluate(executionId: string, planTaskId: string): Promise<GateResult> {
    const ctx = await this.#load(executionId, planTaskId);
    return this.#evaluate(ctx, await this.#o.executions.events(executionId));
  }

  /**
   * Evaluates; on failure sends the work back to Mimir, spending one attempt of the task's
   * shared budget (`execution_tasks.attempts`, also used by DeliveryLoop for runtime failures):
   * - a failed task is retried (key `sindri:retry:<task>:<attempt>`, shared with DeliveryLoop)
   *   with a repair instruction to its latest session;
   * - a completed task gets a repair task in the same crew while the mission is open.
   * Blocked or incomplete verification, a closed mission, or a refusal by Mimir escalate.
   */
  async enforce(executionId: string, planTaskId: string): Promise<EnforceOutcome> {
    const ctx = await this.#load(executionId, planTaskId);
    const events = await this.#o.executions.events(executionId);
    const result = await this.#evaluate(ctx, events);
    if (result.passed) return { action: "none", result };
    const verdict = result.engineering?.verdict;
    if (verdict === "blocked" || verdict === "incomplete") return { action: "escalated", result };
    if (ctx.execTask.attempts >= ctx.planTask.maxRetries) return { action: "exhausted", result };

    const mission = await this.#o.mimir.getMission(ctx.execution.mimirMissionId);
    const target = ctx.lineage.at(-1)!;
    const targetTask = mission.tasks.find((t) => t.id === target);
    const status = targetTask?.status ?? ctx.execTask.status;

    if (status === "failed") {
      const attempt = await this.#o.executions.claimAttempt(executionId, planTaskId);
      if (attempt > ctx.planTask.maxRetries) return { action: "exhausted", result };
      const instruction = repairInstruction(ctx.planTask, result.failures, attempt);
      const session = latestSession(events, target);
      try {
        if (session) {
          await this.#o.mimir.sendInstruction(
            session,
            instruction,
            `sindri:gate-repair:${executionId}:${planTaskId}:${attempt}:instruction`,
          );
        }
        await this.#o.mimir.retry(target, attempt, instruction);
      } catch (e) {
        // Mimir only retries failed tasks with attempts left; anything else needs a human.
        return { action: "escalated", result, error: e instanceof Error ? e.message : String(e) };
      }
      this.#recordRepair(ctx, result, attempt, instruction, "retry", null);
      return { action: "retried", attempt, result };
    }

    if (status === "completed") {
      const crewId = targetTask?.crewId;
      if (TERMINAL_MISSION.has(mission.status) || !crewId) return { action: "escalated", result };
      const attempt = await this.#o.executions.claimAttempt(executionId, planTaskId);
      if (attempt > ctx.planTask.maxRetries) return { action: "exhausted", result };
      const instruction = repairInstruction(ctx.planTask, result.failures, attempt);
      let repairTaskId: string;
      try {
        ({ taskId: repairTaskId } = await this.#o.mimir.createTask(
          {
            missionId: ctx.execution.mimirMissionId,
            crewId,
            title: `repair-${planTaskId}-${attempt}: repair ${planTaskId} after failed quality gates`,
            instruction,
            acceptance: ctx.planTask.acceptanceCriteria.join(", "),
            dependsOn: [target],
          },
          `sindri:repair:${executionId}:${planTaskId}:${attempt}`,
        ));
      } catch (e) {
        return { action: "escalated", result, error: e instanceof Error ? e.message : String(e) };
      }
      this.#recordRepair(ctx, result, attempt, instruction, "repair_task", repairTaskId);
      return { action: "repair_task_created", attempt, repairTaskId, result };
    }

    // Still running or verifying: nothing to repair yet.
    return { action: "pending", result };
  }

  latest(executionId: string, planTaskId: string): GateResult | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM gate_evaluations WHERE execution_id = ? AND plan_task_id = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(executionId, planTaskId) as EvaluationRow | undefined;
    return row && toResult(row);
  }

  history(executionId: string, planTaskId: string): GateResult[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM gate_evaluations WHERE execution_id = ? AND plan_task_id = ? ORDER BY rowid`,
        )
        .all(executionId, planTaskId) as EvaluationRow[]
    ).map(toResult);
  }

  repairs(
    executionId: string,
    planTaskId: string,
  ): { attempt: number; kind: string; repairTaskId: string | null; instruction: string }[] {
    return (
      this.#db
        .prepare(
          `SELECT attempt, kind, repair_task_id, instruction FROM gate_repairs
           WHERE execution_id = ? AND plan_task_id = ? ORDER BY attempt`,
        )
        .all(executionId, planTaskId) as {
        attempt: number;
        kind: string;
        repair_task_id: string | null;
        instruction: string;
      }[]
    ).map((r) => ({
      attempt: r.attempt,
      kind: r.kind,
      repairTaskId: r.repair_task_id,
      instruction: r.instruction,
    }));
  }

  /** The plan task's Mimir task followed by its repair tasks. */
  lineage(executionId: string, planTaskId: string, mimirTaskId: string): string[] {
    const repairs = (
      this.#db
        .prepare(
          `SELECT repair_task_id FROM gate_repairs
           WHERE execution_id = ? AND plan_task_id = ? AND repair_task_id IS NOT NULL
           ORDER BY attempt`,
        )
        .all(executionId, planTaskId) as { repair_task_id: string }[]
    ).map((r) => r.repair_task_id);
    return [mimirTaskId, ...repairs];
  }

  // -------------------------------------------------------------------------------------------

  async #load(executionId: string, planTaskId: string): Promise<Context> {
    const execution = await this.#o.executions.execution(executionId);
    if (!execution) throw new GateError(`unknown execution ${executionId}`);
    const planTask = execution.plan.tasks.find((t) => t.id === planTaskId);
    const execTask = (await this.#o.executions.tasks(executionId)).find(
      (t) => t.planTaskId === planTaskId,
    );
    if (!planTask || !execTask) {
      throw new GateError(`unknown plan task ${planTaskId} in execution ${executionId}`);
    }
    return {
      execution,
      planTask,
      execTask,
      lineage: this.lineage(executionId, planTaskId, execTask.mimirTaskId),
    };
  }

  async #evaluate(ctx: Context, events: ExecutionEventView[]): Promise<GateResult> {
    const lineage = new Set(ctx.lineage);
    const artifacts = recordedArtifacts(events, this.#trust).filter((a) => lineage.has(a.taskId));
    const failures: GateFailure[] = [];
    const advisories: GateFailure[] = [];
    const engineering = await this.#engineering(ctx, events, failures);

    for (const gate of this.#o.gatesFor?.(ctx.planTask) ?? []) {
      const failure = await this.#product(gate, ctx, events, artifacts, engineering?.report);
      if (!failure) continue;
      (gate.required === false ? advisories : failures).push(failure);
    }

    const row: EvaluationRow = {
      id: `gev_${randomUUID()}`,
      execution_id: ctx.execution.id,
      project_id: ctx.execution.plan.projectId,
      plan_task_id: ctx.planTask.id,
      mimir_task_id: ctx.execTask.mimirTaskId,
      passed: failures.length === 0 ? 1 : 0,
      engineering_verdict: engineering?.report.verdict ?? null,
      report_artifact_id: engineering?.reportArtifactId ?? null,
      failures_json: JSON.stringify(failures),
      advisories_json: JSON.stringify(advisories),
      evaluated_at: this.#now().toISOString(),
    };
    this.#db
      .prepare(
        `INSERT INTO gate_evaluations (id, execution_id, project_id, plan_task_id, mimir_task_id,
           passed, engineering_verdict, report_artifact_id, failures_json, advisories_json,
           evaluated_at)
         VALUES (@id, @execution_id, @project_id, @plan_task_id, @mimir_task_id, @passed,
           @engineering_verdict, @report_artifact_id, @failures_json, @advisories_json,
           @evaluated_at)`,
      )
      .run(row);
    return toResult(row);
  }

  #recordRepair(
    ctx: Context,
    result: GateResult,
    attempt: number,
    instruction: string,
    kind: "retry" | "repair_task",
    repairTaskId: string | null,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO gate_repairs (id, execution_id, project_id, plan_task_id, mimir_task_id,
           attempt, evaluation_id, instruction, created_at, kind, repair_task_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `grp_${randomUUID()}`,
        ctx.execution.id,
        ctx.execution.plan.projectId,
        ctx.planTask.id,
        ctx.execTask.mimirTaskId,
        attempt,
        result.evaluationId,
        instruction,
        this.#now().toISOString(),
        kind,
        repairTaskId,
      );
  }

  /** Reports recorded by a trusted source after the task entered `verifying`, newest last. */
  #reportCandidates(events: ExecutionEventView[], lineage: Set<string>): RecordedArtifact[] {
    const verifying = new Set<string>();
    const out: RecordedArtifact[] = [];
    for (const e of events) {
      if (!e.mimirTaskId || !lineage.has(e.mimirTaskId) || !isTrusted(e, this.#trust)) continue;
      if (e.type === "task.verifying") verifying.add(e.mimirTaskId);
      if (e.type !== "artifact.recorded") continue;
      const [a] = recordedArtifacts([e], this.#trust);
      if (!a || a.kind !== BROKKR_REPORT_KIND || !verifying.has(a.taskId)) continue;
      verifying.delete(a.taskId); // one report per verifying step
      out.push(a);
    }
    return out;
  }

  async #engineering(
    ctx: Context,
    events: ExecutionEventView[],
    failures: GateFailure[],
  ): Promise<{ report: VerificationReport; reportArtifactId: string } | null> {
    const lineage = new Set(ctx.lineage);
    const latest = this.#reportCandidates(events, lineage).at(-1);
    if (!latest) {
      failures.push({ gateId: ENGINEERING_GATE_ID, reason: "verification_report_missing" });
      return null;
    }
    const ref = latest.artifactId;
    const read = await readVerifiedArtifact(this.#o.mimir, this.#o.content, ref, {
      taskId: latest.taskId,
      kind: BROKKR_REPORT_KIND,
    });
    if (!read.ok) {
      failures.push({ gateId: ENGINEERING_GATE_ID, reason: read.reason, evidenceRef: ref });
      return null;
    }
    const parsed = parseVerificationReport(read.text);
    if (!parsed.ok) {
      failures.push({
        gateId: ENGINEERING_GATE_ID,
        reason: "verification_report_invalid",
        evidenceRef: ref,
      });
      return null;
    }
    // The commit the report must cover: the `headSha` Mimir's server recorded in the
    // `changed-files` manifest of the same verifying step. Never the worktree base.
    let expectedCommit: string | null = null;
    const manifest = manifestOfVerifyingStep(events, latest.taskId, latest.eventId, this.#trust);
    if (manifest) {
      const mread = await readVerifiedArtifact(
        this.#o.mimir,
        this.#o.content,
        manifest.artifactId,
        {
          taskId: latest.taskId,
          kind: manifest.kind,
        },
      );
      if (mread.ok) expectedCommit = manifestHead(mread.text);
      else {
        failures.push({
          gateId: ENGINEERING_GATE_ID,
          reason: mread.reason,
          evidenceRef: manifest.artifactId,
        });
      }
    }
    failures.push(
      ...evaluateEngineering(
        parsed.value,
        {
          planTaskId: ctx.planTask.id,
          mimirTaskId: latest.taskId,
          harnessLockDigest: ctx.planTask.harnessLockDigest,
          expectedCommit,
        },
        ref,
      ),
    );
    return { report: parsed.value, reportArtifactId: ref };
  }

  async #product(
    gate: GateSpec,
    ctx: Context,
    events: ExecutionEventView[],
    artifacts: RecordedArtifact[],
    report: VerificationReport | undefined,
  ): Promise<GateFailure | null> {
    const fail = (reason: string, evidenceRef?: string | null): GateFailure => ({
      gateId: gate.id,
      reason,
      ...(evidenceRef ? { evidenceRef } : {}),
    });
    const lineage = new Set(ctx.lineage);
    switch (gate.kind) {
      case "review-artifact": {
        const artifact = artifacts.filter((a) => a.kind === "review").at(-1);
        if (!artifact) return fail("review_missing");
        const read = await readVerifiedArtifact(
          this.#o.mimir,
          this.#o.content,
          artifact.artifactId,
          { taskId: artifact.taskId, kind: artifact.kind },
        );
        if (!read.ok) return fail(read.reason, artifact.artifactId);
        let parsed;
        try {
          parsed = ReviewFileSchema.safeParse(JSON.parse(read.text));
        } catch {
          return fail("unparseable_review", artifact.artifactId);
        }
        if (!parsed.success) return fail("unparseable_review", artifact.artifactId);
        const review = parsed.data;
        if (
          review.verdict !== "approve" ||
          review.findings.some((f) =>
            (BLOCKING_SEVERITIES as readonly string[]).includes(f.severity),
          )
        )
          return fail("review_request_changes", artifact.artifactId);
        const assessed = new Set<string>();
        for (const item of review.acceptance) {
          if (
            assessed.has(item.criterionId) ||
            !ctx.planTask.acceptanceCriteria.includes(item.criterionId) ||
            !item.satisfied
          )
            return fail("acceptance_not_satisfied", artifact.artifactId);
          assessed.add(item.criterionId);
        }
        if (ctx.planTask.acceptanceCriteria.some((id) => !assessed.has(id)))
          return fail("acceptance_unreviewed", artifact.artifactId);
        return null;
      }
      case "command": {
        const run = testRuns(events, this.#trust)
          .filter((r) => r.taskId !== null && lineage.has(r.taskId) && r.command === gate.command)
          .at(-1);
        if (run && run.passed && run.exitCode === 0) return null;
        const brokkrOk = (report?.checks ?? []).some(
          (c) => c.command?.join(" ") === gate.command && c.state === "passed" && c.exitCode === 0,
        );
        if ((!run || (run.passed && run.exitCode === null)) && brokkrOk) return null;
        if (!run) return fail("command_not_run");
        if (run.passed && run.exitCode === null) {
          return fail("command_exit_code_unrecorded", run.eventId);
        }
        return fail("command_failed", run.eventId);
      }
      case "artifact": {
        const artifact = artifacts.filter((a) => a.kind === gate.artifactKind).at(-1);
        if (!artifact) return fail("artifact_missing");
        if (!sha256Hex(artifact.hash)) return fail("artifact_hash_invalid", artifact.artifactId);
        try {
          const resolved = await this.#o.mimir.getArtifact(artifact.artifactId);
          if (
            resolved.taskId !== artifact.taskId ||
            resolved.kind !== artifact.kind ||
            resolved.hash !== artifact.hash
          ) {
            return fail("artifact_mismatch", artifact.artifactId);
          }
        } catch {
          return fail("artifact_unavailable", artifact.artifactId);
        }
        return null;
      }
      case "review": {
        const review = this.#o.reviews?.latestFor(ctx.execution.id, ctx.planTask.id);
        if (!review) return fail("review_missing");
        if (review.status !== "completed") return fail("review_pending");
        const ref = review.reviewArtifactId;
        if (review.verdict !== "approve") {
          return fail(`review_request_changes:${review.reason ?? "findings"}`, ref);
        }
        if (review.implementerAttempt < ctx.execTask.attempts) return fail("review_stale", ref);
        // Whatever the stated verdict (audit M1; ruling: `major` blocks too).
        if (review.findings.some((f) => f.severity === "critical" || f.severity === "blocking")) {
          return fail("review_critical_finding", ref);
        }
        if (review.findings.some((f) => f.severity === "major")) {
          return fail("review_major_finding", ref);
        }
        // Each criterion of this task assessed exactly once (review m1, m2).
        const seen = new Set<string>();
        for (const a of review.acceptance) {
          if (seen.has(a.criterionId)) return fail(`acceptance_duplicate:${a.criterionId}`, ref);
          seen.add(a.criterionId);
        }
        for (const a of review.acceptance) {
          if (!ctx.planTask.acceptanceCriteria.includes(a.criterionId))
            return fail(`acceptance_unknown:${a.criterionId}`, ref);
        }
        const assessed = new Map(review.acceptance.map((a) => [a.criterionId, a.satisfied]));
        for (const id of ctx.planTask.acceptanceCriteria) {
          if (assessed.get(id) === false) return fail(`acceptance_not_met:${id}`, ref);
        }
        for (const id of ctx.planTask.acceptanceCriteria) {
          if (!assessed.has(id)) return fail(`acceptance_unreviewed:${id}`, ref);
        }
        return null;
      }
    }
  }
}
