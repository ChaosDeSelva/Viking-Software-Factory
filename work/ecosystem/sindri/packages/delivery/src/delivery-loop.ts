import { randomUUID } from "node:crypto";
import { ensureDeliverySchema } from "./schema.js";
import type { SqliteDatabase } from "@sindri/knowledge";
import {
  isMimirError,
  type ApprovalDecision,
  type MimirClientFacade,
  type MimirEvent,
} from "@sindri/mimir-client";
import type { Escalation, Plan, PlanTask } from "@sindri/planner";

export const EXECUTION_STATUSES = [
  "pending",
  "running",
  "awaiting_human",
  "blocked",
  "replan_requested",
  "verified_pending_review",
  "cancelled",
  "failed",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

const FINAL: readonly ExecutionStatus[] = ["verified_pending_review", "cancelled", "failed"];

/**
 * What Sindri does with a Mimir `approval.requested`. Actions in `deny` are rejected at once;
 * everything else goes to the inbox for a human. There is deliberately no auto-approve list.
 */
export interface PermissionPolicy {
  /**
   * Informational: actions the project expects to need approval. Unlisted actions go to the
   * inbox too (deny by default), so this list never changes what the loop does.
   */
  requireApproval: string[];
  deny?: string[];
}

/** Structural logger (compatible with `@sindri/director`'s `Logger`). */
export interface DeliveryLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** A human's answer to an escalated task. */
export type EscalationDecision = "retry" | "skip" | "replan" | "abort";

export interface ResolveEscalationInput {
  decision: EscalationDecision;
  actor: string;
  reason: string;
  signal?: AbortSignal;
}

export interface InboxItem {
  id: string;
  executionId: string;
  kind: "escalation" | "budget_exceeded";
  planTaskId: string | null;
  detail: unknown;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}

export interface Execution {
  id: string;
  planId: string;
  planVersion: number;
  mimirMissionId: string;
  status: ExecutionStatus;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** 1 for the first execution of a plan version, 2 for the next, ... */
  runNumber: number;
}

export interface ExecutionTask {
  id: string;
  executionId: string;
  planTaskId: string;
  mimirTaskId: string;
  /** Mimir task status, from `task.*` events only. */
  status: string;
  /** Failed attempts seen so far. */
  attempts: number;
  lastEventCursor: string | null;
  escalation: Escalation | null;
  escalationReason: string | null;
  /** Set when a human skipped the task (or it sat behind a skipped task). */
  resolution: "skipped" | "skipped_dependency" | null;
  /** Why Sindri considers the task blocked (e.g. `budget_exceeded: tokens 120/100`). */
  blockedReason: string | null;
  /** The latest Mimir session seen on this task's events (agent deep links), if any. */
  sessionId: string | null;
}

export interface ExecutionApproval {
  id: string;
  executionId: string;
  mimirApprovalId: string;
  planTaskId: string | null;
  action: string;
  reason: string | null;
  disposition: "inbox" | "auto_rejected";
  status: "pending" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedAt: string | null;
}

export interface ArtifactRef {
  id: string;
  executionId: string;
  mimirArtifactId: string;
  planTaskId: string | null;
  kind: string;
  sha256: string;
  uri: string;
}

export interface ExecutionEventRow {
  id: string;
  /** Null for rows Sindri wrote itself (`source: "sindri"`). */
  mimirEventId: string | null;
  source: "mimir" | "sindri";
  type: string;
  payload: unknown;
  occurredAt: string;
}

export type DeliveryNotice =
  | { type: "event"; executionId: string; eventType: string; mimirEventId: string }
  | { type: "status_changed"; executionId: string; from: ExecutionStatus; to: ExecutionStatus }
  | {
      type: "awaiting_human";
      executionId: string;
      approvalId: string;
      action: string;
      planTaskId: string | null;
    }
  | {
      type: "escalated";
      executionId: string;
      planTaskId: string;
      escalation: Escalation;
      reason: string;
    }
  /** For S6: the plan needs revising before this execution can finish. */
  | { type: "replan_requested"; executionId: string; planTaskId: string; reason: string }
  | {
      type: "inbox_item";
      executionId: string;
      inboxId: string;
      kind: InboxItem["kind"];
      planTaskId: string | null;
    };

export interface RunResult {
  status: ExecutionStatus;
  /** True when the run stopped because its signal aborted, not because the execution settled. */
  interrupted: boolean;
}

export interface DeliveryLoopOptions {
  db: SqliteDatabase;
  /** Should share `db`, so event rows and the follow cursor commit in one transaction. */
  mimir: MimirClientFacade;
  permissionPolicy?: PermissionPolicy;
  now?: () => Date;
  /** Default writes warnings to `console.warn`. */
  logger?: DeliveryLogger;
  /**
   * Owner of verification failures (`task.failed` with a `verification_*` reason): S6's
   * `GateRunner.enforce`. It spends attempts from the same `execution_tasks.attempts` counter and
   * retries under the same `sindri:retry:<task>:<attempt>` keys, so runtime and verification
   * failures share one `maxRetries` budget. Without it, DeliveryLoop retries every failure.
   */
  verificationFailures?: VerificationFailureHandler;
}

/** Handles a verification failure; `retried`/`repair_task_created` mean the task goes on. */
export interface VerificationFailureHandler {
  enforce(executionId: string, planTaskId: string): Promise<{ action: string; error?: string }>;
}

const isVerificationFailure = (reason: string) => reason.startsWith("verification_");

interface ExecutionRow {
  id: string;
  plan_id: string;
  plan_version: number;
  mimir_mission_id: string;
  status: ExecutionStatus;
  started_at: string | null;
  finished_at: string | null;
  plan_json: string;
  created_at: string;
  run_number: number;
}

interface TaskRow {
  id: string;
  execution_id: string;
  plan_task_id: string;
  mimir_task_id: string;
  status: string;
  attempts: number;
  last_event_cursor: string | null;
  escalation: Escalation | null;
  escalation_reason: string | null;
  resolution: ExecutionTask["resolution"];
  blocked_reason: string | null;
  session_id: string | null;
}

interface ApprovalRow {
  id: string;
  execution_id: string;
  mimir_approval_id: string;
  plan_task_id: string | null;
  action: string;
  reason: string | null;
  disposition: "inbox" | "auto_rejected";
  status: ExecutionApproval["status"];
  requested_at: string;
  decided_at: string | null;
}

/** Side-effect decisions made before an event's rows are committed. */
interface Decision {
  retry?: { attempts: number };
  escalate?: { escalation: Escalation; reason: string };
  approval?: { disposition: "inbox" | "auto_rejected" };
}

/**
 * Executes an approved plan through Mimir and reconciles Mimir's events into Sindri's execution
 * records. Task state changes only on `task.*` events; agent text never moves state. Approval
 * requests are surfaced to the inbox (or rejected when the policy denies the action); Sindri
 * never approves on its own.
 */
export class DeliveryLoop {
  private readonly db: SqliteDatabase;
  private readonly mimir: MimirClientFacade;
  private readonly policy: PermissionPolicy;
  private readonly now: () => Date;
  private readonly listeners = new Set<(n: DeliveryNotice) => void>();
  private readonly logger: DeliveryLogger;
  private readonly verificationFailures: VerificationFailureHandler | undefined;

  constructor(options: DeliveryLoopOptions) {
    this.db = options.db;
    this.mimir = options.mimir;
    this.policy = options.permissionPolicy ?? { requireApproval: [] };
    this.verificationFailures = options.verificationFailures;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? {
      warn: (msg, fields) => console.warn(`[sindri/delivery] ${msg}`, fields ?? {}),
    };
    ensureDeliverySchema(this.db);
  }

  /** Subscribe to notices; returns an unsubscribe function. */
  on(listener: (n: DeliveryNotice) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Submits the plan to Mimir and records the execution. For a plan version that already has a
   * non-final execution, returns it (the Mimir submission is idempotent too). After a finished
   * execution, a new one gets the next run number and therefore a new Mimir mission; it never
   * reattaches to the old mission.
   */
  async createExecution(plan: Plan, { projectId }: { projectId: string }): Promise<Execution> {
    const existing = this.db
      .prepare(
        `SELECT * FROM executions WHERE plan_id = ? AND plan_version = ?
         AND status NOT IN ('verified_pending_review', 'cancelled', 'failed')
         ORDER BY created_at LIMIT 1`,
      )
      .get(plan.id, plan.version) as ExecutionRow | undefined;
    if (existing) return toExecution(existing);
    const run =
      (
        this.db
          .prepare(
            "SELECT COALESCE(MAX(run_number), 0) AS n FROM executions WHERE plan_id = ? AND plan_version = ?",
          )
          .get(plan.id, plan.version) as { n: number }
      ).n + 1;
    const submission = await this.mimir.createMissionFromPlan(plan, { projectId, run });
    const id = `exe_${randomUUID()}`;
    const at = this.now().toISOString();
    // Token and cost budgets went to Mimir with the crews; wall-clock limits cannot be enforced there.
    const budgets = submission.unforwardedBudgets;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO executions (id, plan_id, plan_version, mimir_mission_id, status, plan_json, created_at, run_number, project_id)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .run(
          id,
          plan.id,
          plan.version,
          submission.missionId,
          JSON.stringify(plan),
          at,
          run,
          plan.projectId,
        );
      const insert = this.db.prepare(
        `INSERT INTO execution_tasks (id, execution_id, plan_task_id, mimir_task_id, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      );
      for (const task of plan.tasks) {
        const mimirTaskId = submission.taskIdMap[task.id];
        if (!mimirTaskId) throw new Error(`Mimir returned no task for plan task ${task.id}`);
        insert.run(`ext_${randomUUID()}`, id, task.id, mimirTaskId);
      }
      if (budgets.length > 0) {
        this.recordSindriEvent(id, "budget_not_forwarded", {
          reason: "Mimir budgets are token and cost limits; wall-clock minutes are not enforced",
          tasks: budgets,
        });
      }
    })();
    if (budgets.length > 0) {
      this.logger.warn("wall-clock budgets are not enforced by Mimir", {
        executionId: id,
        planId: plan.id,
        planVersion: plan.version,
        tasks: budgets.length,
      });
    }
    return this.get(id) as Execution;
  }

  /** Starts the mission (idempotently) and consumes its events until the execution settles. */
  async run(executionId: string, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    const row = this.row(executionId);
    if (FINAL.includes(row.status)) return { status: row.status, interrupted: false };
    if (!row.started_at) {
      this.db
        .prepare("UPDATE executions SET started_at = ? WHERE id = ?")
        .run(this.now().toISOString(), executionId);
    }
    if (row.status === "pending") this.setStatus(executionId, "running");
    await this.mimir.start(row.mimir_mission_id);
    return this.consume(executionId, options.signal);
  }

  /** Continues after a restart or a human decision, replaying from the stored cursor. */
  async resume(executionId: string, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.run(executionId, options);
  }

  /**
   * Passes a human's decision to Mimir and records it locally. The caller is the human's agent
   * (UI/CLI); the loop itself never calls this.
   */
  async decideApproval(
    executionId: string,
    mimirApprovalId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    const approval = this.db
      .prepare("SELECT * FROM execution_approvals WHERE execution_id = ? AND mimir_approval_id = ?")
      .get(executionId, mimirApprovalId) as ApprovalRow | undefined;
    if (!approval)
      throw new Error(`approval ${mimirApprovalId} is not in execution ${executionId}`);
    await this.mimir.decideApproval(mimirApprovalId, decision, reason);
    this.db
      .prepare(
        "UPDATE execution_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(decision, this.now().toISOString(), approval.id);
    if (decision === "approved" && this.pendingApprovals(executionId) === 0) {
      const status = this.row(executionId).status;
      if (status === "awaiting_human" && !this.hasEscalation(executionId, "ask")) {
        this.setStatus(executionId, "running");
      }
    }
  }

  /**
   * A human's answer to an escalated task (any escalation; `ask` ones are also in the inbox):
   * - `retry`: clears the escalation and asks Mimir for one more attempt, then continues;
   * - `skip`: marks the task (and tasks waiting on it) skipped, then continues; when nothing else
   *   is left, cancels the Mimir mission, which can no longer complete, and finishes;
   * - `replan`: turns the escalation into `replan`, emitting `replan_requested`;
   * - `abort`: cancels the Mimir mission and ends the execution `cancelled`.
   * Every decision is recorded as a Sindri `escalation_resolved` event.
   */
  async resolveEscalation(
    executionId: string,
    planTaskId: string,
    input: ResolveEscalationInput,
  ): Promise<RunResult> {
    const row = this.row(executionId);
    const task = this.db
      .prepare("SELECT * FROM execution_tasks WHERE execution_id = ? AND plan_task_id = ?")
      .get(executionId, planTaskId) as TaskRow | undefined;
    if (!task) throw new Error(`task ${planTaskId} is not in execution ${executionId}`);
    if (!task.escalation) throw new Error(`task ${planTaskId} is not escalated`);
    if (FINAL.includes(row.status)) throw new Error(`execution ${executionId} is ${row.status}`);
    const plan = JSON.parse(row.plan_json) as Plan;
    const { decision, actor, reason } = input;
    const at = this.now().toISOString();

    if (decision === "retry") {
      await this.mimir.retry(task.mimir_task_id, {
        attempt: task.attempts + 1,
        reason: `human retry by ${actor}: ${reason}`,
      });
    }
    if (decision === "abort") {
      await this.mimir.cancel(row.mimir_mission_id, `aborted by ${actor}: ${reason}`);
    }

    const notices: DeliveryNotice[] = [];
    this.db.transaction(() => {
      this.recordSindriEvent(executionId, "escalation_resolved", {
        planTaskId,
        decision,
        actor,
        reason,
        previous: { escalation: task.escalation, reason: task.escalation_reason },
      });
      this.db
        .prepare(
          `UPDATE execution_inbox SET status = 'resolved', resolved_at = ?
           WHERE execution_id = ? AND plan_task_id = ? AND status = 'open'`,
        )
        .run(at, executionId, planTaskId);
      switch (decision) {
        case "retry":
          this.db
            .prepare(
              `UPDATE execution_tasks SET escalation = NULL, escalation_reason = NULL,
                 blocked_reason = NULL WHERE id = ?`,
            )
            .run(task.id);
          this.setStatusIn(executionId, "running", notices);
          break;
        case "skip": {
          this.db
            .prepare(
              `UPDATE execution_tasks SET escalation = NULL, escalation_reason = NULL,
                 resolution = 'skipped' WHERE id = ?`,
            )
            .run(task.id);
          const skipped = new Set([planTaskId]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const pt of plan.tasks) {
              if (skipped.has(pt.id) || !pt.dependsOn.some((d) => skipped.has(d))) continue;
              skipped.add(pt.id);
              grew = true;
              this.db
                .prepare(
                  `UPDATE execution_tasks SET resolution = 'skipped_dependency'
                   WHERE execution_id = ? AND plan_task_id = ? AND status <> 'completed'`,
                )
                .run(executionId, pt.id);
            }
          }
          this.setStatusIn(executionId, "running", notices);
          break;
        }
        case "replan":
          this.db
            .prepare(
              "UPDATE execution_tasks SET escalation = 'replan', escalation_reason = ? WHERE id = ?",
            )
            .run(`replan requested by ${actor}: ${reason}`, task.id);
          notices.push({ type: "replan_requested", executionId, planTaskId, reason });
          this.setStatusIn(executionId, "replan_requested", notices);
          break;
        case "abort":
          this.db
            .prepare("UPDATE executions SET finished_at = ? WHERE id = ?")
            .run(at, executionId);
          this.setStatusIn(executionId, "cancelled", notices);
          break;
      }
    })();
    for (const n of notices) this.notify(n);
    if (decision === "abort" || decision === "replan") {
      return { status: this.row(executionId).status, interrupted: false };
    }
    return this.resume(executionId, input.signal ? { signal: input.signal } : {});
  }

  /** Open and resolved inbox items that are not Mimir approvals (see `approvals`). */
  inbox(executionId: string): InboxItem[] {
    return (
      this.db
        .prepare("SELECT * FROM execution_inbox WHERE execution_id = ? ORDER BY rowid")
        .all(executionId) as {
        id: string;
        execution_id: string;
        kind: InboxItem["kind"];
        plan_task_id: string | null;
        detail_json: string;
        status: InboxItem["status"];
        created_at: string;
        resolved_at: string | null;
      }[]
    ).map((r) => ({
      id: r.id,
      executionId: r.execution_id,
      kind: r.kind,
      planTaskId: r.plan_task_id,
      detail: JSON.parse(r.detail_json) as unknown,
      status: r.status,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
    }));
  }

  get(executionId: string): Execution | undefined {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as
      ExecutionRow | undefined;
    return row ? toExecution(row) : undefined;
  }

  tasks(executionId: string): ExecutionTask[] {
    return (
      this.db
        .prepare("SELECT * FROM execution_tasks WHERE execution_id = ? ORDER BY rowid")
        .all(executionId) as TaskRow[]
    ).map(toTask);
  }

  approvals(executionId: string): ExecutionApproval[] {
    return (
      this.db
        .prepare("SELECT * FROM execution_approvals WHERE execution_id = ? ORDER BY rowid")
        .all(executionId) as ApprovalRow[]
    ).map((r) => ({
      id: r.id,
      executionId: r.execution_id,
      mimirApprovalId: r.mimir_approval_id,
      planTaskId: r.plan_task_id,
      action: r.action,
      reason: r.reason,
      disposition: r.disposition,
      status: r.status,
      requestedAt: r.requested_at,
      decidedAt: r.decided_at,
    }));
  }

  artifacts(executionId: string): ArtifactRef[] {
    return (
      this.db
        .prepare("SELECT * FROM artifacts_refs WHERE execution_id = ? ORDER BY rowid")
        .all(executionId) as {
        id: string;
        execution_id: string;
        mimir_artifact_id: string;
        plan_task_id: string | null;
        kind: string;
        sha256: string;
        uri: string;
      }[]
    ).map((r) => ({
      id: r.id,
      executionId: r.execution_id,
      mimirArtifactId: r.mimir_artifact_id,
      planTaskId: r.plan_task_id,
      kind: r.kind,
      sha256: r.sha256,
      uri: r.uri,
    }));
  }

  events(executionId: string): ExecutionEventRow[] {
    return (
      this.db
        .prepare("SELECT * FROM execution_events WHERE execution_id = ? ORDER BY rowid")
        .all(executionId) as {
        id: string;
        mimir_event_id: string | null;
        source: "mimir" | "sindri";
        type: string;
        payload_json: string;
        occurred_at: string;
      }[]
    ).map((r) => ({
      id: r.id,
      mimirEventId: r.mimir_event_id,
      source: r.source,
      type: r.type,
      payload: JSON.parse(r.payload_json) as unknown,
      occurredAt: r.occurred_at,
    }));
  }

  // -------------------------------------------------------------------------------------------

  private async consume(executionId: string, signal?: AbortSignal): Promise<RunResult> {
    const row = this.row(executionId);
    const plan = JSON.parse(row.plan_json) as Plan;
    const missionId = row.mimir_mission_id;
    // Catch up on everything Mimir recorded since the stored cursor (for example a decision a
    // human made in Mimir while this execution was awaiting_human) before deciding whether the
    // execution is settled.
    const backlog = await this.mimir.catchUp(missionId, signal ? { signal } : {});
    for (const event of backlog.events) await this.handle(executionId, plan, event, undefined);
    if (backlog.cursor) this.mimir.saveCursor(missionId, backlog.cursor);
    const settled = await this.settle(executionId, plan);
    if (settled) return { status: settled, interrupted: false };
    if (signal?.aborted) return { status: this.row(executionId).status, interrupted: true };

    // An inner controller lets the loop end the stream once the execution settles.
    const inner = new AbortController();
    const abort = () => inner.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const stream = this.mimir.follow(missionId, { signal: inner.signal });
      for await (const event of stream) {
        await this.handle(executionId, plan, event, stream.cursor);
        const done = await this.settle(executionId, plan);
        if (done) return { status: done, interrupted: false };
        if (signal?.aborted) break;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      inner.abort();
    }
    return { status: this.row(executionId).status, interrupted: true };
  }

  private async handle(
    executionId: string,
    plan: Plan,
    event: MimirEvent,
    cursor: string | undefined,
  ): Promise<void> {
    const missionId = this.row(executionId).mimir_mission_id;
    const seen = this.db
      .prepare("SELECT 1 FROM execution_events WHERE execution_id = ? AND mimir_event_id = ?")
      .get(executionId, event.id);
    if (seen) {
      if (cursor) this.mimir.saveCursor(missionId, cursor);
      return;
    }
    const task = event.taskId ? this.taskByMimirId(executionId, event.taskId) : undefined;
    const planTask = task ? plan.tasks.find((t) => t.id === task.plan_task_id) : undefined;

    // 1. Side effects on Mimir first. Each is idempotent (deterministic keys), so a crash before
    //    the commit below replays them harmlessly.
    const decision = await this.decide(event, task, planTask);

    // 2. Commit the event, the derived state and the cursor together.
    const notices: DeliveryNotice[] = [
      { type: "event", executionId, eventType: event.type, mimirEventId: event.id },
    ];
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO execution_events (id, execution_id, mimir_event_id, type, payload_json, occurred_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `exv_${randomUUID()}`,
          executionId,
          event.id,
          event.type,
          JSON.stringify(event.payload),
          event.occurredAt,
        );
      this.apply(executionId, event, task, planTask, decision, notices);
      if (task && cursor) {
        this.db
          .prepare("UPDATE execution_tasks SET last_event_cursor = ? WHERE id = ?")
          .run(cursor, task.id);
      }
      if (cursor) this.mimir.saveCursor(missionId, cursor);
    })();
    for (const n of notices) this.notify(n);
  }

  private async decide(
    event: MimirEvent,
    task: TaskRow | undefined,
    planTask: PlanTask | undefined,
  ): Promise<Decision> {
    if (
      event.type === "task.failed" &&
      task &&
      planTask &&
      this.verificationFailures &&
      isVerificationFailure(event.payload.reason)
    ) {
      // Single owner per failure class: GateRunner spends the shared attempt and retries.
      const outcome = await this.verificationFailures.enforce(task.execution_id, planTask.id);
      if (outcome.action === "retried" || outcome.action === "repair_task_created") return {};
      return {
        escalate: {
          escalation: planTask.escalation,
          reason: `verification failed; gate repair ${outcome.action}${outcome.error ? `: ${outcome.error}` : ""}`,
        },
      };
    }
    if (event.type === "task.failed" && task && planTask) {
      const attempts = task.attempts + 1;
      if (attempts <= planTask.maxRetries) {
        try {
          await this.mimir.retry(task.mimir_task_id, {
            attempt: attempts,
            reason: `sindri retry ${attempts} of ${planTask.maxRetries}: ${event.payload.reason}`,
          });
          return { retry: { attempts } };
        } catch (err) {
          if (!isMimirError(err)) throw err;
          return {
            retry: { attempts },
            escalate: {
              escalation: planTask.escalation,
              reason: `retry refused by Mimir (${err.code}): ${err.message}`,
            },
          };
        }
      }
      return {
        retry: { attempts },
        escalate: {
          escalation: planTask.escalation,
          reason: `failed after ${attempts} attempt(s): ${event.payload.reason}`,
        },
      };
    }
    if (event.type === "approval.requested") {
      const denied = this.policy.deny?.includes(event.payload.action) ?? false;
      if (denied) {
        await this.mimir.decideApproval(
          event.payload.approvalId,
          "rejected",
          `action ${event.payload.action} is denied by Sindri's permission policy`,
        );
        return { approval: { disposition: "auto_rejected" } };
      }
      return { approval: { disposition: "inbox" } };
    }
    if (event.type === "approval.decided" && event.payload.decision === "rejected" && planTask) {
      return {
        escalate: { escalation: planTask.escalation, reason: "approval rejected" },
      };
    }
    return {};
  }

  private apply(
    executionId: string,
    event: MimirEvent,
    task: TaskRow | undefined,
    planTask: PlanTask | undefined,
    decision: Decision,
    notices: DeliveryNotice[],
  ): void {
    const at = this.now().toISOString();
    // Remember the task's current session (envelope ref; never terminal text) for deep links.
    if (task && event.sessionId)
      this.db
        .prepare("UPDATE execution_tasks SET session_id = ? WHERE id = ?")
        .run(event.sessionId, task.id);
    if (task && event.type.startsWith("task.") && event.type !== "task.created") {
      const to = (event.payload as { to?: string }).to;
      if (to)
        this.db.prepare("UPDATE execution_tasks SET status = ? WHERE id = ?").run(to, task.id);
    }
    if (task && decision.retry) {
      this.db
        .prepare("UPDATE execution_tasks SET attempts = ? WHERE id = ?")
        .run(decision.retry.attempts, task.id);
    }
    if (task && planTask && decision.escalate) {
      const { escalation, reason } = decision.escalate;
      this.db
        .prepare("UPDATE execution_tasks SET escalation = ?, escalation_reason = ? WHERE id = ?")
        .run(escalation, reason, task.id);
      notices.push({ type: "escalated", executionId, planTaskId: planTask.id, escalation, reason });
      if (escalation === "replan") {
        notices.push({ type: "replan_requested", executionId, planTaskId: planTask.id, reason });
      }
      if (escalation === "ask") {
        this.openInbox(executionId, "escalation", planTask.id, { reason }, notices);
      }
    }
    switch (event.type) {
      case "approval.requested": {
        const disposition = decision.approval?.disposition ?? "inbox";
        this.db
          .prepare(
            `INSERT INTO execution_approvals (id, execution_id, mimir_approval_id, plan_task_id,
               action, reason, disposition, status, requested_at, decided_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mimir_approval_id) DO NOTHING`,
          )
          .run(
            `exa_${randomUUID()}`,
            executionId,
            event.payload.approvalId,
            planTask?.id ?? null,
            event.payload.action,
            event.payload.reason ?? null,
            disposition,
            disposition === "auto_rejected" ? "rejected" : "pending",
            event.occurredAt,
            disposition === "auto_rejected" ? at : null,
          );
        if (disposition === "inbox") {
          this.setStatusIn(executionId, "awaiting_human", notices);
          notices.push({
            type: "awaiting_human",
            executionId,
            approvalId: event.payload.approvalId,
            action: event.payload.action,
            planTaskId: planTask?.id ?? null,
          });
        }
        break;
      }
      case "approval.decided": {
        this.db
          .prepare(
            `UPDATE execution_approvals SET status = ?, decided_at = COALESCE(decided_at, ?)
             WHERE mimir_approval_id = ?`,
          )
          .run(event.payload.decision, at, event.payload.approvalId);
        break;
      }
      case "approval.expired": {
        this.db
          .prepare("UPDATE execution_approvals SET status = 'expired' WHERE mimir_approval_id = ?")
          .run(event.payload.approvalId);
        break;
      }
      case "artifact.recorded": {
        const owner = this.taskByMimirId(executionId, event.payload.taskId);
        this.db
          .prepare(
            `INSERT INTO artifacts_refs (id, execution_id, mimir_artifact_id, plan_task_id, kind, sha256, uri)
             VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(execution_id, mimir_artifact_id) DO NOTHING`,
          )
          .run(
            `arf_${randomUUID()}`,
            executionId,
            event.payload.artifactId,
            owner?.plan_task_id ?? null,
            event.payload.kind,
            event.payload.hash,
            event.payload.uri,
          );
        break;
      }
      case "mission.cancelled": {
        // A cancel Sindri itself sent after skipping/aborting arrives after the execution ended.
        if (FINAL.includes(this.row(executionId).status)) break;
        this.setStatusIn(executionId, "cancelled", notices);
        this.db.prepare("UPDATE executions SET finished_at = ? WHERE id = ?").run(at, executionId);
        break;
      }
      case "budget.exceeded": {
        const { unit, used, limit, budgetId } = event.payload;
        const blockedReason = `budget_exceeded: ${unit} ${used}/${limit}`;
        if (task) {
          this.db
            .prepare(
              `UPDATE execution_tasks SET status = 'blocked', blocked_reason = ?,
                 escalation = COALESCE(escalation, 'ask'),
                 escalation_reason = COALESCE(escalation_reason, ?) WHERE id = ?`,
            )
            .run(blockedReason, blockedReason, task.id);
          notices.push({
            type: "escalated",
            executionId,
            planTaskId: task.plan_task_id,
            escalation: "ask",
            reason: blockedReason,
          });
        }
        this.openInbox(
          executionId,
          "budget_exceeded",
          task?.plan_task_id ?? null,
          { budgetId, unit, used, limit, mimirEventId: event.id },
          notices,
        );
        break;
      }
      default:
        break;
    }
    if (
      this.row(executionId).status === "awaiting_human" &&
      this.pendingApprovals(executionId) === 0 &&
      !this.hasEscalation(executionId, "ask") &&
      event.type === "approval.decided"
    ) {
      this.setStatusIn(executionId, "running", notices);
    }
  }

  private openInbox(
    executionId: string,
    kind: InboxItem["kind"],
    planTaskId: string | null,
    detail: unknown,
    notices: DeliveryNotice[],
  ): void {
    const inboxId = `exi_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO execution_inbox (id, execution_id, kind, plan_task_id, detail_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        inboxId,
        executionId,
        kind,
        planTaskId,
        JSON.stringify(detail),
        this.now().toISOString(),
      );
    this.setStatusIn(executionId, "awaiting_human", notices);
    notices.push({ type: "inbox_item", executionId, inboxId, kind, planTaskId });
  }

  private recordSindriEvent(executionId: string, type: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO execution_events (id, execution_id, mimir_event_id, source, type, payload_json, occurred_at)
         VALUES (?, ?, NULL, 'sindri', ?, ?, ?)`,
      )
      .run(
        `exv_${randomUUID()}`,
        executionId,
        type,
        JSON.stringify(payload),
        this.now().toISOString(),
      );
  }

  private openInboxItems(executionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM execution_inbox WHERE execution_id = ? AND status = 'open'",
        )
        .get(executionId) as { n: number }
    ).n;
  }

  /**
   * The execution's settled status, or null while work can still progress. On
   * `mission.completed` it first collects the artifacts (see `collectArtifacts`).
   */
  private async settle(executionId: string, plan: Plan): Promise<ExecutionStatus | null> {
    const row = this.row(executionId);
    if (FINAL.includes(row.status)) return row.status;
    const completed = this.db
      .prepare(
        "SELECT 1 FROM execution_events WHERE execution_id = ? AND type = 'mission.completed'",
      )
      .get(executionId);
    if (completed) {
      await this.collectArtifacts(executionId);
      this.db
        .prepare("UPDATE executions SET finished_at = ? WHERE id = ?")
        .run(this.now().toISOString(), executionId);
      this.setStatus(executionId, "verified_pending_review");
      return "verified_pending_review";
    }
    const tasks = this.tasks(executionId);
    const byPlanId = new Map(tasks.map((t) => [t.planTaskId, t]));
    const pendingApprovalTasks = new Set(
      this.approvals(executionId)
        .filter((a) => a.status === "pending" && a.planTaskId)
        .map((a) => a.planTaskId as string),
    );
    const stuck = new Map<string, boolean>();
    const isStuck = (id: string): boolean => {
      const cached = stuck.get(id);
      if (cached !== undefined) return cached;
      stuck.set(id, false);
      const t = byPlanId.get(id);
      const pt = plan.tasks.find((p) => p.id === id);
      let result = false;
      if (!t) result = true;
      else if (t.resolution || t.escalation || t.status === "cancelled") result = true;
      else if (t.status === "blocked" && pendingApprovalTasks.has(id)) result = true;
      else if (t.status === "pending" && pt) {
        result = pt.dependsOn.some((d) => isStuck(d) || byPlanId.get(d)?.status === "cancelled");
      }
      stuck.set(id, result);
      return result;
    };
    const open = tasks.filter((t) => t.status !== "completed" && !t.resolution);
    if (open.length === 0) {
      if (!tasks.some((t) => t.resolution)) return null; // all completed: wait for mission.completed
      // Everything left was skipped by a human: Mimir can never complete this mission.
      await this.mimir.cancel(row.mimir_mission_id, "remaining tasks skipped by a human in Sindri");
      await this.collectArtifacts(executionId);
      this.db
        .prepare("UPDATE executions SET finished_at = ? WHERE id = ?")
        .run(this.now().toISOString(), executionId);
      this.setStatus(executionId, "verified_pending_review");
      return "verified_pending_review";
    }
    if (!open.every((t) => isStuck(t.planTaskId))) return null;
    const escalations = tasks.map((t) => t.escalation).filter(Boolean);
    let status: ExecutionStatus;
    if (escalations.includes("replan")) status = "replan_requested";
    else if (
      escalations.includes("ask") ||
      this.pendingApprovals(executionId) > 0 ||
      this.openInboxItems(executionId) > 0
    ) {
      status = "awaiting_human";
    } else status = "blocked";
    this.setStatus(executionId, status);
    return status;
  }

  /**
   * Re-reads every recorded artifact (test outputs, diffs, manifests) from Mimir and stores the
   * hash Mimir holds for it, so the refs match what S6's gates will read.
   */
  private async collectArtifacts(executionId: string): Promise<void> {
    for (const ref of this.artifacts(executionId)) {
      const artifact = await this.mimir.getArtifact(ref.mimirArtifactId);
      this.db
        .prepare("UPDATE artifacts_refs SET sha256 = ?, uri = ?, kind = ? WHERE id = ?")
        .run(artifact.hash, artifact.uri, artifact.kind, ref.id);
    }
  }

  private pendingApprovals(executionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM execution_approvals WHERE execution_id = ? AND status = 'pending'",
        )
        .get(executionId) as { n: number }
    ).n;
  }

  private hasEscalation(executionId: string, escalation: Escalation): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM execution_tasks WHERE execution_id = ? AND escalation = ?")
        .get(executionId, escalation) !== undefined
    );
  }

  private taskByMimirId(executionId: string, mimirTaskId: string): TaskRow | undefined {
    return this.db
      .prepare("SELECT * FROM execution_tasks WHERE execution_id = ? AND mimir_task_id = ?")
      .get(executionId, mimirTaskId) as TaskRow | undefined;
  }

  private row(executionId: string): ExecutionRow {
    const row = this.db.prepare("SELECT * FROM executions WHERE id = ?").get(executionId) as
      ExecutionRow | undefined;
    if (!row) throw new Error(`unknown execution ${executionId}`);
    return row;
  }

  private setStatus(executionId: string, to: ExecutionStatus): void {
    const notices: DeliveryNotice[] = [];
    this.setStatusIn(executionId, to, notices);
    for (const n of notices) this.notify(n);
  }

  private setStatusIn(executionId: string, to: ExecutionStatus, notices: DeliveryNotice[]): void {
    const from = this.row(executionId).status;
    if (from === to) return;
    this.db.prepare("UPDATE executions SET status = ? WHERE id = ?").run(to, executionId);
    notices.push({ type: "status_changed", executionId, from, to });
  }

  private notify(n: DeliveryNotice): void {
    for (const l of this.listeners) l(n);
  }
}

function toExecution(r: ExecutionRow): Execution {
  return {
    id: r.id,
    planId: r.plan_id,
    planVersion: r.plan_version,
    mimirMissionId: r.mimir_mission_id,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    createdAt: r.created_at,
    runNumber: r.run_number,
  };
}

function toTask(r: TaskRow): ExecutionTask {
  return {
    id: r.id,
    executionId: r.execution_id,
    planTaskId: r.plan_task_id,
    mimirTaskId: r.mimir_task_id,
    status: r.status,
    attempts: r.attempts,
    lastEventCursor: r.last_event_cursor,
    escalation: r.escalation,
    escalationReason: r.escalation_reason,
    resolution: r.resolution,
    blockedReason: r.blocked_reason,
    sessionId: r.session_id ?? null,
  };
}
