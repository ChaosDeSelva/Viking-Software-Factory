import { z } from "zod";
import {
  ApprovalDecisionSchema,
  MissionStatusSchema,
  ProvenanceSchema,
  RuntimeSessionStateSchema,
  TaskStatusSchema,
} from "./enums.js";
import {
  BudgetPolicySchema,
  CrewMemberSchema,
  CrewSchema,
  ProjectSchema,
  UsageSampleSchema,
} from "./entities.js";
import { MimirError } from "./errors.js";
import {
  AgentIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  BudgetIdSchema,
  CrewIdSchema,
  EventIdSchema,
  GitShaSchema,
  MissionIdSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  TaskIdSchema,
  TimestampSchema,
  WorktreeIdSchema,
} from "./ids.js";

export const EVENT_TYPES = [
  "mission.created",
  "mission.started",
  "mission.paused",
  "mission.resumed",
  "mission.cancelled",
  "mission.completed",
  "task.created",
  "task.ready",
  "task.leased",
  "task.started",
  "task.blocked",
  "task.verifying",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.retried",
  "session.requested",
  "session.started",
  "session.state_changed",
  "session.output",
  "session.exited",
  "session.lost",
  "tool.invoked",
  "tool.completed",
  "git.worktree_created",
  "git.worktree_removed",
  "git.commit_observed",
  "git.conflict_detected",
  "test.run_completed",
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "budget.warning",
  "budget.exceeded",
  "policy.denied",
  "recovery.reconciled",
  "recovery.unknown_marked",
  "summary.created",
  "artifact.recorded",
  "mission.failed",
  "session.input",
  "project.created",
  "crew.created",
  "crew.scheduling_changed",
  "usage.recorded",
  "approval.consumed",
  "artifact.collection_skipped",
  "artifact.collection_truncated",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z
  .object({
    id: EventIdSchema,
    schemaVersion: z.literal(1),
    /** Ordering is guaranteed per stream only; there is no global order. */
    streamId: z.string().min(1),
    sequence: z.number().int().min(0),
    occurredAt: TimestampSchema,
    observedAt: TimestampSchema,
    type: EventTypeSchema,
    source: z.string().min(1),
    sourceEventId: z.string().optional(),
    provenance: ProvenanceSchema,
    correlationId: z.string().optional(),
    missionId: MissionIdSchema.optional(),
    crewId: CrewIdSchema.optional(),
    taskId: TaskIdSchema.optional(),
    sessionId: SessionIdSchema.optional(),
    payload: z.unknown(),
  })
  .meta({ id: "EventEnvelope" });
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Runtime-specific handles for a session (HerdR pane/terminal/workspace ids, agent session id). */
export const RuntimeRefSchema = z.object({
  paneId: z.string().exactOptional(),
  terminalId: z.string().exactOptional(),
  workspaceId: z.string().exactOptional(),
  agentSessionId: z.string().exactOptional(),
});
export type RuntimeRef = z.infer<typeof RuntimeRefSchema>;

const missionTransition = <S extends z.infer<typeof MissionStatusSchema>>(to: S) =>
  z.object({ from: MissionStatusSchema, to: z.literal(to), reason: z.string().optional() });

const taskTransition = <S extends z.infer<typeof TaskStatusSchema>, X extends z.ZodRawShape>(
  to: S,
  extra: X,
) => z.object({ from: TaskStatusSchema, to: z.literal(to), ...extra });

const budgetPayload = () =>
  z.object({
    budgetId: BudgetIdSchema,
    unit: z.enum(["tokens", "cost"]),
    used: z.number().min(0),
    limit: z.number().min(0),
  });

export const EVENT_PAYLOAD_SCHEMAS = {
  "mission.created": z.object({
    projectId: ProjectIdSchema,
    objective: z.string(),
    /** Mission-wide budget, enforced by the scheduler. */
    budget: BudgetPolicySchema.optional(),
  }),
  "mission.started": missionTransition("active"),
  "mission.paused": missionTransition("paused"),
  "mission.resumed": missionTransition("active"),
  "mission.cancelled": missionTransition("cancelled"),
  "mission.completed": missionTransition("completed"),
  "task.created": z.object({
    priority: z.number().int().min(0).max(100).optional(),
    verification: z.record(z.string(), z.unknown()).optional(),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
    missionId: MissionIdSchema,
    crewId: CrewIdSchema.nullable(),
    title: z.string(),
    acceptance: z.string(),
    dependsOn: z.array(TaskIdSchema),
    /** Substituted into the crew role's argv template (the agent brief or shell command). */
    brief: z.string().optional(),
    /** Explicit argv replacing the role template. */
    argv: z.array(z.string()).min(1).optional(),
  }),
  "task.ready": taskTransition("ready", {}),
  "task.leased": taskTransition("leased", {
    agentId: AgentIdSchema,
    attempt: z.number().int().min(1),
    leaseExpiresAt: TimestampSchema,
  }),
  "task.started": taskTransition("running", { agentId: AgentIdSchema, sessionId: SessionIdSchema }),
  "task.blocked": taskTransition("blocked", { reason: z.string() }),
  "task.verifying": taskTransition("verifying", {}),
  "task.completed": taskTransition("completed", { resultCommit: GitShaSchema.optional() }),
  "task.failed": taskTransition("failed", {
    reason: z.string(),
    attempt: z.number().int().min(0),
    retryable: z.boolean(),
  }),
  "task.cancelled": taskTransition("cancelled", { reason: z.string().optional() }),
  "task.retried": z.object({
    from: TaskStatusSchema,
    to: TaskStatusSchema.extract(["pending", "ready"]),
    attempt: z.number().int().min(1),
    reason: z.string().optional(),
  }),
  "session.requested": z.object({
    agentKind: z.string(),
    crewId: CrewIdSchema,
    taskId: TaskIdSchema,
    workspaceLabel: z.string(),
  }),
  "session.started": z.object({ runtime: z.string(), runtimeRef: RuntimeRefSchema }),
  "session.state_changed": z.object({
    from: RuntimeSessionStateSchema,
    to: RuntimeSessionStateSchema,
    runtimeStatus: z.string().optional(),
  }),
  "session.output": z.object({
    text: z.string(),
    redacted: z.boolean(),
    lines: z.number().int().min(0),
  }),
  "session.exited": z.object({ exitCode: z.number().int().optional() }),
  "session.lost": z.object({ reason: z.string() }),
  "tool.invoked": z.object({
    tool: z.string(),
    toolCallId: z.string().optional(),
    input: z.unknown().optional(),
  }),
  "tool.completed": z.object({
    tool: z.string(),
    toolCallId: z.string().optional(),
    ok: z.boolean(),
    durationMs: z.number().min(0).optional(),
  }),
  "git.worktree_created": z.object({
    worktreeId: WorktreeIdSchema,
    path: z.string(),
    branch: z.string(),
    baseSha: GitShaSchema,
    /** Ref the branch started from; restored with the worktree after a restart. */
    baseRef: z.string().min(1).optional(),
  }),
  "git.worktree_removed": z.object({ worktreeId: WorktreeIdSchema, path: z.string() }),
  "git.commit_observed": z.object({
    worktreeId: WorktreeIdSchema.optional(),
    sha: GitShaSchema,
    branch: z.string(),
    message: z.string().optional(),
  }),
  "git.conflict_detected": z.object({
    worktreeId: WorktreeIdSchema.optional(),
    branch: z.string(),
    files: z.array(z.string()),
  }),
  "test.run_completed": z.object({
    command: z.string(),
    passed: z.boolean(),
    total: z.number().int().min(0).optional(),
    failed: z.number().int().min(0).optional(),
    durationMs: z.number().min(0).optional(),
    /** Process exit code; null when it was killed (timeout or signal). */
    exitCode: z.number().int().nullable().optional(),
    /** Captured output, capped (the full output is an artifact). */
    output: z.string().optional(),
  }),
  "approval.requested": z.object({
    approvalId: ApprovalIdSchema,
    action: z.string(),
    expiry: TimestampSchema.nullable(),
    reason: z.string().optional(),
    /** The action instance this approval covers (e.g. `pr:<taskId>`); consumed once. */
    subject: z.string().min(1).optional(),
    /** Who asked; a requester can never approve its own request. */
    requestedBy: z
      .object({ kind: z.enum(["agent", "human", "system"]), id: z.string().min(1) })
      .optional(),
  }),
  "approval.decided": z.object({
    approvalId: ApprovalIdSchema,
    decision: ApprovalDecisionSchema,
    actor: z.string(),
    reason: z.string().optional(),
  }),
  "approval.expired": z.object({ approvalId: ApprovalIdSchema }),
  "budget.warning": budgetPayload(),
  "budget.exceeded": budgetPayload(),
  "policy.denied": z.object({
    action: z.string(),
    reason: z.string(),
    policyId: PolicyIdSchema.optional(),
  }),
  "recovery.reconciled": z.object({
    sessions: z.number().int().min(0),
    lostSessionIds: z.array(SessionIdSchema),
    /** True when the runtime reported (or Mimir detected) a gap in the event stream. */
    gap: z.boolean(),
  }),
  "recovery.unknown_marked": z.object({
    entityType: z.enum(["task", "session", "agent"]),
    entityId: z.string(),
    reason: z.string(),
  }),
  "summary.created": z.object({
    scope: z.enum(["mission", "crew", "task", "session"]),
    text: z.string(),
    sourceEventIds: z.array(EventIdSchema),
  }),
  "artifact.recorded": z.object({
    artifactId: ArtifactIdSchema,
    taskId: TaskIdSchema,
    kind: z.string(),
    uri: z.string(),
    hash: z.string(),
    /** Size of the stored content in bytes. */
    bytes: z.number().int().min(0).optional(),
    /** File name, for artifacts collected from `<worktree>/.mimir/artifacts/`. */
    name: z.string().min(1).optional(),
  }),
  /** A file under `<worktree>/.mimir/artifacts/` that was not recorded, and why. */
  "artifact.collection_skipped": z.object({
    taskId: TaskIdSchema,
    name: z.string().min(1),
    reason: z.enum([
      "symlink",
      "not_a_file",
      "file_too_large",
      "total_too_large",
      "unreadable",
      "outside_worktree",
    ]),
    bytes: z.number().int().min(0).optional(),
    limitBytes: z.number().int().min(0).optional(),
  }),
  /** More files than the collection limit: the first `kept` (by name) were considered. */
  "artifact.collection_truncated": z.object({
    taskId: TaskIdSchema,
    found: z.number().int().min(0),
    kept: z.number().int().min(0),
    limit: z.number().int().min(0),
  }),
  "mission.failed": missionTransition("failed"),
  /** Operator input sent to a session (text redacted before storage). */
  "session.input": z.object({ text: z.string(), redacted: z.boolean() }),
  "project.created": z.object({ project: ProjectSchema }),
  "crew.scheduling_changed": z.object({ crewId: CrewIdSchema, paused: z.boolean() }),
  "crew.created": z.object({
    crew: CrewSchema,
    members: z.array(CrewMemberSchema),
    budget: BudgetPolicySchema.optional(),
  }),
  "usage.recorded": z.object({ sample: UsageSampleSchema }),
  /** An approved approval was used for its action instance; it cannot be used again. */
  "approval.consumed": z.object({
    approvalId: ApprovalIdSchema,
    subject: z.string().min(1).optional(),
  }),
} as const satisfies Record<EventType, z.ZodType>;

export type EventPayloadMap = {
  [K in EventType]: z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>;
};

export function payloadSchemaFor<T extends EventType>(type: T): (typeof EVENT_PAYLOAD_SCHEMAS)[T] {
  return EVENT_PAYLOAD_SCHEMAS[type];
}

/** An envelope whose payload is narrowed to its type's schema. */
export type TypedEvent<T extends EventType> = Omit<EventEnvelope, "type" | "payload"> & {
  type: T;
  payload: EventPayloadMap[T];
};

/** Discriminated union of every typed event. */
export type MimirEvent = { [K in EventType]: TypedEvent<K> }[EventType];

export interface ValidationIssue {
  path: (string | number)[];
  message: string;
  code: string;
}

export function toValidationIssues(
  error: z.ZodError,
  prefix: (string | number)[] = [],
): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: [...prefix, ...i.path.map((p) => (typeof p === "symbol" ? String(p) : p))],
    message: i.message,
    code: i.code,
  }));
}

/**
 * Validate an event envelope and its type-specific payload.
 * Accepts a JSON string or an already-parsed value. Throws `MimirError('validation_failed')`
 * with `details.issues` (payload issues are prefixed with `"payload"`).
 */
export function parseEvent(json: unknown): MimirEvent {
  let value = json;
  if (typeof json === "string") {
    try {
      value = JSON.parse(json);
    } catch (cause) {
      throw new MimirError(
        "validation_failed",
        "event is not valid JSON",
        { issues: [] },
        { cause },
      );
    }
  }
  const envelope = EventEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new MimirError("validation_failed", "invalid event envelope", {
      issues: toValidationIssues(envelope.error),
    });
  }
  const payload = payloadSchemaFor(envelope.data.type).safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new MimirError("validation_failed", `invalid payload for ${envelope.data.type}`, {
      issues: toValidationIssues(payload.error, ["payload"]),
    });
  }
  return { ...envelope.data, payload: payload.data } as MimirEvent;
}
