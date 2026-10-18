import { z } from "zod";
import {
  AgentSchema,
  ApprovalSchema,
  ArtifactSchema,
  CrewLimitsSchema,
  CrewMemberSchema,
  CrewSchema,
  MissionSchema,
  ProjectSchema,
  TaskDependencySchema,
  TaskSchema,
  UsageSampleSchema,
  WorktreeSchema,
} from "./entities.js";
import { BudgetEnforceSchema, BudgetOnUnknownSchema, ProjectSettingsSchema } from "./entities.js";
import {
  ApprovalDecisionSchema,
  ApprovalStatusSchema,
  CrewRoleSchema,
  MissionStatusSchema,
  TaskStatusSchema,
  RuntimeSessionStateSchema,
} from "./enums.js";
import {
  EventEnvelopeSchema,
  EventTypeSchema,
  RuntimeRefSchema,
  type EventType,
} from "./events.js";
import {
  AgentIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  CommandIdSchema,
  CrewIdSchema,
  MissionIdSchema,
  OperationIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  TaskIdSchema,
} from "./ids.js";
import { RuntimeCapabilitiesSchema } from "./runtime.js";
import { PROTOCOL_VERSION } from "./version.js";

/** Every mutation must send this header (HTTP header names are case-insensitive). */
export const IDEMPOTENCY_HEADER = "idempotency-key";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** Response for asynchronous mutations (HTTP 202). */
export const OperationAcceptedSchema = z
  .object({
    operationId: OperationIdSchema,
    commandId: CommandIdSchema,
  })
  .meta({ id: "OperationAccepted" });
export type OperationAccepted = z.infer<typeof OperationAcceptedSchema>;

const expectedVersion = z.number().int().min(0).optional();

// ---------------------------------------------------------------------------
// Path params
// ---------------------------------------------------------------------------

export const MissionIdParamsSchema = z.object({ id: MissionIdSchema });
export type MissionIdParams = z.infer<typeof MissionIdParamsSchema>;
export const TaskIdParamsSchema = z.object({ id: TaskIdSchema });
export type TaskIdParams = z.infer<typeof TaskIdParamsSchema>;
export const ApprovalIdParamsSchema = z.object({ id: ApprovalIdSchema });
export type ApprovalIdParams = z.infer<typeof ApprovalIdParamsSchema>;
export const SessionIdParamsSchema = z.object({ id: SessionIdSchema });
export type SessionIdParams = z.infer<typeof SessionIdParamsSchema>;
export const ArtifactIdParamsSchema = z.object({ id: ArtifactIdSchema });
export type ArtifactIdParams = z.infer<typeof ArtifactIdParamsSchema>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const CreateProjectRequestSchema = z.strictObject({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  settings: ProjectSettingsSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const CreateProjectResponseSchema = z.object({ project: ProjectSchema });
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

export const ListProjectsResponseSchema = z.object({ projects: z.array(ProjectSchema) });
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/** Budget limits for a mission or crew. Omitted limits are unlimited. */
export const BudgetInputSchema = z.strictObject({
  limitTokens: z.number().int().min(0).optional(),
  limitCost: z.number().min(0).optional(),
  /** Fraction of a limit at which `budget.warning` is emitted (default 0.8). */
  warnAtFraction: z.number().min(0).max(1).optional(),
  enforce: BudgetEnforceSchema.optional(),
  onUnknown: BudgetOnUnknownSchema.optional(),
});
export type BudgetInput = z.infer<typeof BudgetInputSchema>;

/** One task of a mission's DAG. */
export const TaskInputSchema = z.strictObject({
  priority: z.number().int().min(0).max(100).optional(),
  /** Operator-provided verification contract, persisted independently of agent files. */
  verification: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  /** Client-chosen task id (so `dependsOn` can refer to tasks created in the same call). */
  id: TaskIdSchema.optional(),
  title: z.string().min(1),
  /** The agent brief (agent kinds) or the shell command (`shell` kind) for the role's argv template. */
  brief: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  /** Tasks of the same mission that must complete first. */
  dependsOn: z.array(TaskIdSchema).optional(),
  /** Pin the task to one crew of the mission; any crew of the mission otherwise. */
  crewId: CrewIdSchema.optional(),
  /** Explicit argv, replacing the crew role's template. */
  argv: z.array(z.string()).min(1).optional(),
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const CreateMissionRequestSchema = z.strictObject({
  projectId: ProjectIdSchema,
  objective: z.string().min(1),
  budget: BudgetInputSchema.optional(),
  /** The mission's task DAG, created with the mission (`dependsOn` may reference earlier ids). */
  tasks: z.array(TaskInputSchema).optional(),
});
export type CreateMissionRequest = z.infer<typeof CreateMissionRequestSchema>;

export const CreateMissionResponseSchema = z.object({
  mission: MissionSchema,
  /** Tasks created from `CreateMissionRequest.tasks`, in request order. */
  tasks: z.array(TaskSchema).optional(),
});
export type CreateMissionResponse = z.infer<typeof CreateMissionResponseSchema>;

export const StartMissionRequestSchema = z.strictObject({ expectedVersion });
export type StartMissionRequest = z.infer<typeof StartMissionRequestSchema>;

export const CancelMissionRequestSchema = z.strictObject({
  reason: z.string().optional(),
  expectedVersion,
});
export type CancelMissionRequest = z.infer<typeof CancelMissionRequestSchema>;

export const ListMissionsQuerySchema = z.object({
  projectId: ProjectIdSchema.optional(),
  status: MissionStatusSchema.optional(),
});
export type ListMissionsQuery = z.infer<typeof ListMissionsQuerySchema>;

export const ListMissionsResponseSchema = z.object({ missions: z.array(MissionSchema) });
export type ListMissionsResponse = z.infer<typeof ListMissionsResponseSchema>;

export const GetMissionResponseSchema = z.object({
  mission: MissionSchema,
  crews: z.array(CrewSchema),
  tasks: z.array(TaskSchema),
});
export type GetMissionResponse = z.infer<typeof GetMissionResponseSchema>;

// ---------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------

export const CreateCrewMemberInputSchema = z.strictObject({
  role: CrewRoleSchema,
  agentKind: z.string().min(1),
  name: z.string().min(1).optional(),
});
export type CreateCrewMemberInput = z.infer<typeof CreateCrewMemberInputSchema>;

export const CreateCrewRequestSchema = z.strictObject({
  missionId: MissionIdSchema,
  template: z.string().min(1),
  limits: CrewLimitsSchema.optional(),
  members: z.array(CreateCrewMemberInputSchema).min(1),
  budget: BudgetInputSchema.optional(),
});
export type CreateCrewRequest = z.infer<typeof CreateCrewRequestSchema>;

export const CreateCrewResponseSchema = z.object({
  crew: CrewSchema,
  members: z.array(CrewMemberSchema),
});
export type CreateCrewResponse = z.infer<typeof CreateCrewResponseSchema>;

export const ListCrewsQuerySchema = z.object({ missionId: MissionIdSchema.optional() });
export type ListCrewsQuery = z.infer<typeof ListCrewsQuerySchema>;

export const ListCrewsResponseSchema = z.object({ crews: z.array(CrewSchema) });
export type ListCrewsResponse = z.infer<typeof ListCrewsResponseSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const CreateTaskRequestSchema = TaskInputSchema.extend({ missionId: MissionIdSchema });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;

export const CreateTaskResponseSchema = z.object({ task: TaskSchema });
export type CreateTaskResponse = z.infer<typeof CreateTaskResponseSchema>;

export const RetryTaskRequestSchema = z.strictObject({
  reason: z.string().optional(),
  expectedVersion,
});
export type RetryTaskRequest = z.infer<typeof RetryTaskRequestSchema>;

/** `POST /v1/tasks/:id/pr` takes no fields; the body may be omitted. */
export const RequestPrRequestSchema = z.strictObject({});
export type RequestPrRequest = z.infer<typeof RequestPrRequestSchema>;

/**
 * `POST /v1/tasks/:id/pr` (202). `approval_required`: a human must decide `approvalId` first
 * (delivery runs on approval). `delivered`: the PR (or the local patch) was produced; `prUrl` is
 * set when a pull request URL was observed.
 */
export const RequestPrResponseSchema = z.discriminatedUnion("status", [
  OperationAcceptedSchema.extend({
    status: z.literal("approval_required"),
    approvalId: ApprovalIdSchema,
  }),
  OperationAcceptedSchema.extend({
    status: z.literal("delivered"),
    prUrl: z.url().optional(),
  }),
]);
export type RequestPrResponse = z.infer<typeof RequestPrResponseSchema>;

export const ListTasksQuerySchema = z.object({
  missionId: MissionIdSchema.optional(),
  crewId: CrewIdSchema.optional(),
  status: TaskStatusSchema.optional(),
});
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;

export const ListTasksResponseSchema = z.object({ tasks: z.array(TaskSchema) });
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const GetTaskResponseSchema = z.object({
  task: TaskSchema,
  spec: z.object({ brief: z.string().optional(), argv: z.array(z.string()).optional() }),
  mission: MissionSchema.nullable(),
  dependencies: z.array(TaskDependencySchema),
  sessions: z.array(
    z.object({
      id: z.string(),
      crewId: z.string().nullable(),
      taskId: z.string().nullable(),
      agentKind: z.string().nullable(),
      runtime: z.string().nullable(),
      runtimeRef: RuntimeRefSchema,
      state: RuntimeSessionStateSchema,
      runtimeStatus: z.string().nullable(),
      exitCode: z.number().int().nullable(),
      lostReason: z.string().nullable(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }),
  ),
  worktrees: z.array(WorktreeSchema),
  artifacts: z.array(ArtifactSchema),
  approvals: z.array(ApprovalSchema),
});
export type GetTaskResponse = z.infer<typeof GetTaskResponseSchema>;

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const ApprovalDecisionRequestSchema = z.strictObject({
  decision: ApprovalDecisionSchema,
  reason: z.string().optional(),
});
export type ApprovalDecisionRequest = z.infer<typeof ApprovalDecisionRequestSchema>;

export const ListApprovalsQuerySchema = z.object({
  status: ApprovalStatusSchema.optional(),
  missionId: MissionIdSchema.optional(),
});
export type ListApprovalsQuery = z.infer<typeof ListApprovalsQuerySchema>;

export const ListApprovalsResponseSchema = z.object({ approvals: z.array(ApprovalSchema) });
export type ListApprovalsResponse = z.infer<typeof ListApprovalsResponseSchema>;

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SendInstructionRequestSchema = z.strictObject({ text: z.string().min(1) });
export type SendInstructionRequest = z.infer<typeof SendInstructionRequestSchema>;

export const StopSessionRequestSchema = z.strictObject({ mode: z.enum(["soft", "force"]) });
export type StopSessionRequest = z.infer<typeof StopSessionRequestSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Normalizes `types` (array or comma-separated string) and then validates each entry, so an
 * unknown type is reported at `["types", <index>]`. The declared input type is narrowed to
 * `EventType[] | string` for callers; at runtime any string entries are checked by the pipe.
 */
const EventTypesParamSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (typeof v === "string" ? v.split(",").filter((t) => t.length > 0) : v))
  .pipe(z.array(EventTypeSchema)) as unknown as z.ZodType<EventType[], EventType[] | string>;

/**
 * `limit` accepts a number or a decimal string (query strings). `types` may be an array
 * (`?types=a&types=b`) or a comma-separated string (`?types=a,b`).
 */
export const ListEventsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .union([z.number(), z.string().regex(/^\d+$/, "expected an integer").transform(Number)])
    .pipe(z.number().int().min(1).max(1000))
    .default(200),
  streamId: z.string().min(1).optional(),
  missionId: MissionIdSchema.optional(),
  types: EventTypesParamSchema.optional(),
});
/** What callers send (SDK): every field optional; `limit?: number`, `types?: EventType[]`. */
export type ListEventsQueryInput = z.input<typeof ListEventsQuerySchema>;
/** Caller-facing query type (alias of `ListEventsQueryInput`). */
export type ListEventsQuery = ListEventsQueryInput;
/** What the server gets after parsing: `limit` defaulted to 200, `types` split into an array. */
export type ListEventsQueryParsed = z.output<typeof ListEventsQuerySchema>;

export const ListEventsResponseSchema = z.object({
  events: z.array(EventEnvelopeSchema),
  /** Cursor to resume from; `null` when the caller is caught up. */
  nextCursor: z.string().nullable(),
  /** True while more matching events exist after this page. */
  hasMore: z.boolean().optional(),
  /** Position after this page (set even on the last page), for polling resumption. */
  lastCursor: z.string().min(1).optional(),
});
export type ListEventsResponse = z.infer<typeof ListEventsResponseSchema>;

// ---------------------------------------------------------------------------
// Artifacts & usage
// ---------------------------------------------------------------------------

export const GetArtifactResponseSchema = z.object({ artifact: ArtifactSchema });
export type GetArtifactResponse = z.infer<typeof GetArtifactResponseSchema>;

export const UsageTotalsSchema = z.object({
  tokens: z.number().int().min(0),
  estimatedCost: z.number().min(0),
  /** Number of samples aggregated. */
  samples: z.number().int().min(0),
  /** Sample counts per source, so the UI can show how much is measured vs estimated. */
  bySource: z.object({
    measured: z.number().int().min(0),
    estimated: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageQuerySchema = z.object({
  missionId: MissionIdSchema.optional(),
  agentId: AgentIdSchema.optional(),
  crewId: CrewIdSchema.optional(),
  projectId: ProjectIdSchema.optional(),
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const UsageResponseSchema = z.object({
  totals: UsageTotalsSchema,
  samples: z.array(UsageSampleSchema),
  /** True when any sample has no measurement (`unavailable`) or a null value, so totals are a lower bound. */
  uncertain: z.boolean().optional(),
});
export type UsageResponse = z.infer<typeof UsageResponseSchema>;

// ---------------------------------------------------------------------------
// Snapshot, capabilities, health
// ---------------------------------------------------------------------------

export const SnapshotResponseSchema = z.object({
  projects: z.array(ProjectSchema),
  missions: z.array(MissionSchema),
  crews: z.array(CrewSchema),
  tasks: z.array(TaskSchema),
  taskDependencies: z.array(TaskDependencySchema),
  agents: z.array(AgentSchema),
  approvals: z.array(ApprovalSchema),
  worktrees: z.array(WorktreeSchema),
  usage: UsageTotalsSchema,
  /** Event cursor consistent with this snapshot; pass to `GET /v1/events` to replay from here. */
  cursor: z.string().min(1),
});
export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;

export const CapabilitiesResponseSchema = z.object({
  serverVersion: z.string(),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  runtime: RuntimeCapabilitiesSchema.nullable(),
});
export type CapabilitiesResponse = z.infer<typeof CapabilitiesResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  runtime: z.object({ ok: z.boolean(), detail: z.string().optional() }).optional(),
  /** Event-store integrity: rows refused as corrupt since the server started (degraded when > 0). */
  integrity: z
    .object({
      refusedRows: z.number().int().min(0),
      firstRefusedAt: z.string().nullable(),
    })
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Crew controls pause scheduling only; already running sessions continue. */
export const CrewSchedulingRequestSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().optional(),
});
export type CrewSchedulingRequest = z.infer<typeof CrewSchedulingRequestSchema>;
export const CrewSchedulingResponseSchema = z.object({ crew: CrewSchema, semantics: z.string() });
export type CrewSchedulingResponse = z.infer<typeof CrewSchedulingResponseSchema>;
export const SessionObservationResponseSchema = z.object({
  session: z.unknown().nullable(),
  persisted: z.unknown(),
  observedAt: z.string().nullable(),
  available: z.boolean(),
});
export type SessionObservationResponse = z.infer<typeof SessionObservationResponseSchema>;
export const VerifyTaskResponseSchema = z.object({
  artifactId: z.string(),
  passed: z.boolean(),
  semantics: z.string(),
});
export type VerifyTaskResponse = z.infer<typeof VerifyTaskResponseSchema>;
