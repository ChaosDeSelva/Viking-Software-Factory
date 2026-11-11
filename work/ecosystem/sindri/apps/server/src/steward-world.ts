import { randomUUID } from "node:crypto";
import { SindriError } from "@sindri/knowledge";
import type {
  ActionContext,
  ApplyResult,
  DeliverySubject,
  EscalationSubject,
  Outcome,
  PlanApprovalSubject,
  QuestionSubject,
  SpecApprovalSubject,
  StewardWorld,
} from "@sindri/steward";
import type { Specification } from "@sindri/specs";
import type { FastifyInstance } from "fastify";
import { APPROVAL_HEADER } from "./approval.js";
import { ApiError } from "./errors.js";
import { asMimirUnavailable } from "./execution-hub.js";
import type { Factory } from "./factory.js";
import { executionsByProject } from "./queries.js";
import type { Services } from "./services.js";
import { FINAL_STATUSES } from "./statuses.js";

export interface StewardWorldOptions {
  app: FastifyInstance;
  services: Services;
  factory: Factory;
  /** Bearer token for in-process calls to the server's own routes. */
  authToken: string;
  now: () => Date;
  /** Deliveries verified longer ago than this get no rework suggestion. Default 14 days. */
  deliveryWindowMs?: number;
}

const OPEN_SPEC = new Set(["draft", "review"]);
const latestOf = <T extends { version: number }>(versions: readonly T[]): T | undefined =>
  versions.reduce<T | undefined>((a, b) => (!a || b.version > a.version ? b : a), undefined);

/**
 * The steward's view of Sindri, over the server's services. Actions use the code paths an
 * operator's own request uses: the Director's answer, the delivery loop's escalation resolution
 * (as the execution's single consumer), and the server's own rework and approval routes
 * (called in-process, so their checks and the approval factor apply unchanged).
 */
export class ServerStewardWorld implements StewardWorld {
  readonly #o: StewardWorldOptions;

  constructor(o: StewardWorldOptions) {
    this.#o = o;
  }

  get #s(): Services {
    return this.#o.services;
  }

  #projects(): string[] {
    return this.#s.knowledge.projects.list().map((p) => p.id);
  }

  /** Latest version of every spec lineage of a project. */
  #latestSpecs(projectId: string): Specification[] {
    const byLineage = new Map<string, Specification>();
    for (const sp of this.#s.specs.listByProject(projectId)) {
      const cur = byLineage.get(sp.lineageId);
      if (!cur || sp.version > cur.version) byLineage.set(sp.lineageId, sp);
    }
    return [...byLineage.values()];
  }

  // ------------------------------------------------------------------ readers

  questions(): QuestionSubject[] {
    const out: QuestionSubject[] = [];
    for (const projectId of this.#projects())
      for (const sp of this.#latestSpecs(projectId)) {
        if (!OPEN_SPEC.has(sp.status)) continue;
        for (const q of sp.body.openQuestions)
          out.push({
            projectId,
            specId: sp.id,
            lineageId: sp.lineageId,
            specVersion: sp.version,
            specStatus: sp.status,
            specTitle: sp.title,
            problem: sp.body.problem,
            constraints: sp.body.constraints,
            question: {
              id: q.id,
              text: q.text,
              blocking: q.blocking,
              ...(q.recommendation ? { recommendation: q.recommendation } : {}),
              ...(q.rationale ? { rationale: q.rationale } : {}),
            },
          });
      }
    return out;
  }

  escalations(): EscalationSubject[] {
    const { hub, planner, delivery } = this.#o.factory;
    const out: EscalationSubject[] = [];
    for (const projectId of this.#projects())
      for (const e of executionsByProject(this.#s.db, projectId)) {
        if (FINAL_STATUSES.has(e.status)) continue;
        const tasks = hub.reader.tasks(e.id).filter((t) => t.escalation);
        if (tasks.length === 0) continue;
        const plan = planner.get(e.planId);
        const gates = delivery.gateResults(e.id);
        for (const t of tasks)
          out.push({
            projectId,
            executionId: e.id,
            planTaskId: t.planTaskId,
            objective: plan?.tasks.find((pt) => pt.id === t.planTaskId)?.objective ?? null,
            escalation: t.escalation!,
            reason: t.escalationReason,
            attempts: t.attempts,
            taskStatus: t.status,
            gateFailures: gates
              .filter((g) => g.planTaskId === t.planTaskId)
              .flatMap((g) => g.failures.map((f) => `${f.gateId}: ${f.reason}`)),
          });
      }
    return out;
  }

  deliveries(): DeliverySubject[] {
    const { delivery, planner } = this.#o.factory;
    const window = this.#o.deliveryWindowMs ?? 14 * 24 * 60 * 60 * 1000;
    const since = this.#o.now().getTime() - window;
    const out: DeliverySubject[] = [];
    for (const projectId of this.#projects())
      for (const e of executionsByProject(this.#s.db, projectId)) {
        if (e.status !== "verified_pending_review") continue;
        if (e.finishedAt && Date.parse(e.finishedAt) < since) continue;
        // The operator already asked for changes: nothing left to suggest.
        if (this.#s.rework.forExecution(e.id).length > 0) continue;
        const gates = delivery.gateResults(e.id);
        const reviews = delivery.reviews(e.id);
        // Suggest once the quality assessment has produced something to judge.
        if (gates.length === 0 && reviews.length === 0) continue;
        const plan = planner.get(e.planId);
        out.push({
          projectId,
          executionId: e.id,
          specTitle: plan ? (this.#s.specs.get(plan.specId)?.title ?? null) : null,
          findings: reviews.flatMap((r) =>
            r.findings.length === 0 && r.verdict === "request_changes"
              ? [{ severity: "major", message: r.reason ?? "changes requested", role: r.role }]
              : r.findings.map((f) => ({ severity: f.severity, message: f.message, role: r.role })),
          ),
          gates: gates.map((g) => ({
            planTaskId: g.planTaskId,
            passed: g.passed,
            failures: [...g.failures, ...g.advisories].map((f) => `${f.gateId}: ${f.reason}`),
          })),
        });
      }
    return out;
  }

  specsInReview(): SpecApprovalSubject[] {
    const out: SpecApprovalSubject[] = [];
    for (const projectId of this.#projects())
      for (const sp of this.#latestSpecs(projectId)) {
        if (sp.status !== "review") continue;
        let flagged = false;
        let unverified = 0;
        try {
          const meta = this.#s.director().provenance(sp.id);
          flagged = meta.untrustedInstructionDetected;
          unverified = meta.unverifiedClaims.length;
        } catch {
          // No Director meta for this version: nothing was flagged or left unverified.
        }
        out.push({
          projectId,
          specId: sp.id,
          lineageId: sp.lineageId,
          version: sp.version,
          title: sp.title,
          problem: sp.body.problem,
          blockingQuestions: sp.body.openQuestions.filter((q) => q.blocking).map((q) => q.id),
          acceptanceCriteria: sp.body.acceptanceCriteria.length,
          highRiskAssumptions: sp.body.assumptions
            .filter((a) => a.risk === "high")
            .map((a) => a.text),
          untrustedFlagged: flagged,
          unverifiedClaims: unverified,
        });
      }
    return out;
  }

  plansProposed(): PlanApprovalSubject[] {
    const { planner } = this.#o.factory;
    const out: PlanApprovalSubject[] = [];
    const seen = new Set<string>();
    for (const projectId of this.#projects())
      for (const sp of this.#s.specs.listByProject(projectId))
        for (const plan of planner.listForSpec(sp.id)) {
          if (seen.has(plan.lineageId)) continue;
          seen.add(plan.lineageId);
          const latest = latestOf(planner.listLineage(plan.lineageId));
          if (!latest || (latest.status !== "draft" && latest.status !== "review")) continue;
          const spec = this.#s.specs.get(latest.specId);
          out.push({
            projectId,
            planId: latest.id,
            version: latest.version,
            status: latest.status,
            specId: latest.specId,
            specTitle: spec?.title ?? null,
            specApproved: spec?.status === "approved",
            tasks: latest.tasks.map((t) => ({ id: t.id, objective: t.objective })),
            problems: [],
          });
        }
    return out;
  }

  knowledge(projectId: string): { id: string; claim: string }[] {
    return this.#s.knowledge.knowledge
      .listValid(projectId)
      .map((e) => ({ id: e.id, claim: e.claim }));
  }

  // ------------------------------------------------------------------ outcomes

  /** Executions run from plans of a spec lineage, newest first. */
  #lineageExecutions(lineageId: string): { id: string; status: string }[] {
    return this.#s.db
      .prepare(
        `SELECT e.id, e.status FROM executions e JOIN plans p ON p.id = e.plan_id
         WHERE p.spec_id IN (SELECT id FROM specifications WHERE lineage_id = ?)
         ORDER BY e.created_at DESC, e.rowid DESC`,
      )
      .all(lineageId) as { id: string; status: string }[];
  }

  #runsOutcome(executions: { id: string; status: string }[]): Outcome | null {
    const verified = executions.find((e) => e.status === "verified_pending_review");
    if (verified)
      return this.#s.rework.forExecution(verified.id).length > 0
        ? { result: "reworked", detail: `changes were requested on delivery ${verified.id}` }
        : { result: "passed", detail: `delivery ${verified.id} was verified` };
    const failed = executions.find((e) => e.status === "failed" || e.status === "cancelled");
    if (failed && executions.every((e) => FINAL_STATUSES.has(e.status)))
      return { result: "failed", detail: `execution ${failed.id} ended ${failed.status}` };
    return null;
  }

  outcome(input: {
    type: string;
    context: unknown;
    appliedValue: string | null;
    applied: Record<string, unknown> | null;
  }): Outcome | null {
    const ctx = (input.context ?? {}) as Record<string, unknown>;
    const applied = input.applied ?? {};
    switch (input.type) {
      case "escalation.resolve": {
        const executionId = String(ctx["executionId"] ?? "");
        const planTaskId = String(ctx["planTaskId"] ?? "");
        const execution = this.#o.factory.hub.reader.get(executionId);
        if (!execution) return null;
        const task = this.#o.factory.hub.reader
          .tasks(executionId)
          .find((t) => t.planTaskId === planTaskId);
        if (input.appliedValue === "retry") {
          if (task?.status === "completed")
            return { result: "passed", detail: "the retried task completed" };
          if (task?.escalation && task.attempts > Number(ctx["attempts"] ?? 0))
            return { result: "failed", detail: "the task escalated again after the retry" };
        }
        if (execution.status === "verified_pending_review")
          return { result: "passed", detail: "the run finished verified" };
        if (execution.status === "failed" || execution.status === "cancelled")
          return { result: "failed", detail: `the run ended ${execution.status}` };
        return null;
      }
      case "spec.answer":
      case "spec.approve":
        if (input.type === "spec.approve" && input.appliedValue !== "approve") return null;
        return this.#runsOutcome(this.#lineageExecutions(String(ctx["lineageId"] ?? "")));
      case "plan.approve": {
        if (input.appliedValue !== "approve") return null;
        const rows = this.#s.db
          .prepare(
            "SELECT id, status FROM executions WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC",
          )
          .all(String(ctx["planId"] ?? "")) as { id: string; status: string }[];
        return this.#runsOutcome(rows);
      }
      case "rework.suggest": {
        const executionId = String(ctx["executionId"] ?? "");
        if (input.appliedValue?.trim() === "accept")
          return this.#s.rework.forExecution(executionId).length > 0
            ? { result: "reworked", detail: "changes were requested on the delivery after all" }
            : null;
        return typeof applied["specLineageId"] === "string"
          ? this.#runsOutcome(this.#lineageExecutions(applied["specLineageId"]))
          : null;
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ actions

  /** An in-process call to one of the server's own routes; a refusal is rethrown as is. */
  async #call(
    method: "POST",
    url: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const res = await this.#o.app.inject({
      method,
      url,
      payload: payload as Record<string, unknown>,
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${this.#o.authToken}`,
        "idempotency-key": `steward-${randomUUID()}`,
        ...headers,
      },
    });
    let body: Record<string, unknown>;
    try {
      body = res.json();
    } catch {
      body = {};
    }
    if (res.statusCode >= 400) {
      const err = (body["error"] ?? {}) as { code?: string; message?: string };
      throw new ApiError(
        res.statusCode,
        (err.code ?? "internal") as ConstructorParameters<typeof ApiError>[1],
        err.message ?? `${url} failed with ${res.statusCode}`,
      );
    }
    return body;
  }

  async answerQuestion(
    s: QuestionSubject,
    answer: string,
    ctx: ActionContext,
  ): Promise<ApplyResult> {
    const latest = latestOf(this.#s.specs.listLineage(s.lineageId));
    if (!latest || !OPEN_SPEC.has(latest.status))
      throw new SindriError(
        "invalid_state",
        `the specification is ${latest?.status ?? "gone"}; its questions can no longer be answered here`,
      );
    const q = latest.body.openQuestions.find((x) => x.id === s.question.id);
    if (!q) throw new SindriError("invalid_state", `question ${s.question.id} is no longer open`);
    const index = latest.body.openQuestions.indexOf(q);
    const revised = this.#s.director().answer(latest.id, q.id, answer, { author: ctx.actor });
    const added = revised.body.constraints.slice(latest.body.constraints.length);
    return {
      reversible: true,
      data: {
        lineageId: s.lineageId,
        questionId: q.id,
        question: q,
        questionIndex: index,
        specId: latest.id,
        answeredSpecId: revised.id,
        answeredVersion: revised.version,
        constraints: added,
      },
    };
  }

  /**
   * Revises the spec back to before the answer: the question is reopened and the constraint the
   * answer added is removed, on a new version of the lineage (versions are immutable history).
   * Refused once the answered version, or a later one, was approved or planned.
   */
  async revertAnswer(applied: Record<string, unknown>, ctx: ActionContext): Promise<void> {
    const lineageId = String(applied["lineageId"] ?? "");
    const answeredVersion = Number(applied["answeredVersion"] ?? 0);
    const versions = this.#s.specs.listLineage(lineageId);
    const later = versions.filter((v) => v.version >= answeredVersion);
    const approved = later.find((v) => v.status === "approved" || v.approvedAt !== null);
    if (approved)
      throw new SindriError(
        "invalid_state",
        `version ${approved.version} of this specification was approved after the answer; revise it by hand instead`,
      );
    const planned = later.find((v) => this.#o.factory.planner.listForSpec(v.id).length > 0);
    if (planned)
      throw new SindriError(
        "invalid_state",
        `version ${planned.version} of this specification has a plan; revise it by hand instead`,
      );
    const latest = latestOf(versions);
    if (!latest || !OPEN_SPEC.has(latest.status))
      throw new SindriError(
        "invalid_state",
        `the specification is ${latest?.status ?? "gone"}; it cannot be revised`,
      );
    const q = applied["question"] as Specification["body"]["openQuestions"][number];
    const constraints = [...latest.body.constraints];
    for (const c of (applied["constraints"] as string[] | undefined) ?? []) {
      const i = constraints.lastIndexOf(c);
      if (i >= 0) constraints.splice(i, 1);
    }
    const openQuestions = [...latest.body.openQuestions];
    if (q && !openQuestions.some((x) => x.id === q.id))
      openQuestions.splice(
        Math.min(Number(applied["questionIndex"] ?? openQuestions.length), openQuestions.length),
        0,
        q,
      );
    const revised = this.#s.specs.revise(latest.id, { body: { openQuestions, constraints } });
    this.#s.director().recordRevision(
      latest.id,
      revised.id,
      JSON.stringify({
        rollback: `steward rollback by ${ctx.actor}`,
        openQuestions,
        constraints,
      }),
    );
  }

  async resolveEscalation(
    s: EscalationSubject,
    decision: string,
    reason: string,
    ctx: ActionContext,
  ): Promise<ApplyResult> {
    const { hub } = this.#o.factory;
    const execution = hub.reader.get(s.executionId);
    if (!execution) throw new SindriError("not_found", "execution not found");
    if (FINAL_STATUSES.has(execution.status))
      throw new SindriError("invalid_state", "the execution has finished");
    const task = hub.reader.tasks(s.executionId).find((t) => t.planTaskId === s.planTaskId);
    if (!task?.escalation)
      throw new SindriError("invalid_state", "this task has no open escalation");
    // Each escalation attempt is its own subject: a decision for an earlier one must not
    // resolve the task's new escalation.
    if (task.attempts !== s.attempts)
      throw new SindriError(
        "invalid_state",
        `the task escalated again after ${task.attempts} attempt(s); this decision was for attempt ${s.attempts}`,
      );
    try {
      // Like the escalation route: the resolution resumes the loop, as the execution's consumer.
      await hub.takeover(s.executionId, ({ loop }, signal) =>
        loop.resolveEscalation(s.executionId, s.planTaskId, {
          decision: decision as "retry" | "skip" | "replan" | "abort",
          actor: ctx.actor,
          reason,
          signal,
        }),
      );
    } catch (err) {
      throw asMimirUnavailable(err);
    }
    return {
      reversible: false,
      data: { executionId: s.executionId, planTaskId: s.planTaskId, decision },
    };
  }

  async draftRework(s: DeliverySubject, feedback: string): Promise<ApplyResult> {
    const body = await this.#call(
      "POST",
      `/v1/deliveries/${encodeURIComponent(s.executionId)}/rework`,
      {
        feedback,
      },
    );
    const rework = body["rework"] as { id: string; specLineageId: string };
    const spec = body["spec"] as { id: string };
    return {
      reversible: true,
      data: {
        executionId: s.executionId,
        reworkId: rework.id,
        specId: spec.id,
        specLineageId: rework.specLineageId,
      },
    };
  }

  /** Discards a drafted rework spec while no version of it is approved. */
  async discardRework(applied: Record<string, unknown>): Promise<void> {
    const lineageId = String(applied["specLineageId"] ?? "");
    const versions = this.#s.specs.listLineage(lineageId);
    if (versions.some((v) => v.status === "approved" || v.approvedAt !== null))
      throw new SindriError(
        "invalid_state",
        "the drafted change request was approved meanwhile; it can no longer be discarded",
      );
    this.#s.db.transaction(() => {
      // Superseded versions can be neither revised nor approved: the draft is dead.
      this.#s.db
        .prepare(
          "UPDATE specifications SET status = 'superseded' WHERE lineage_id = ? AND status IN ('draft', 'review')",
        )
        .run(lineageId);
      // Without its rework row the delivery takes a new change request again.
      this.#s.db.prepare("DELETE FROM rework_requests WHERE spec_lineage_id = ?").run(lineageId);
    })();
  }

  async approveSpec(s: SpecApprovalSubject, ctx: ActionContext): Promise<ApplyResult> {
    await this.#call(
      "POST",
      `/v1/specs/${encodeURIComponent(s.specId)}/approve`,
      {},
      this.#approval(ctx),
    );
    return { reversible: false, data: { specId: s.specId } };
  }

  async approvePlan(s: PlanApprovalSubject, ctx: ActionContext): Promise<ApplyResult> {
    // Before the submit: without the approval factor a draft must stay a draft.
    const approval = this.#approval(ctx);
    const plan = this.#o.factory.planner.get(s.planId);
    if (plan?.status === "draft")
      await this.#call("POST", `/v1/plans/${encodeURIComponent(s.planId)}/submit`, {});
    await this.#call("POST", `/v1/plans/${encodeURIComponent(s.planId)}/approve`, {}, approval);
    return { reversible: false, data: { planId: s.planId } };
  }

  #approval(ctx: ActionContext): Record<string, string> {
    if (!ctx.approval)
      throw new ApiError(
        403,
        "approval_required",
        "accepting an approval needs the approval factor",
      );
    return { [APPROVAL_HEADER]: ctx.approval };
  }
}
