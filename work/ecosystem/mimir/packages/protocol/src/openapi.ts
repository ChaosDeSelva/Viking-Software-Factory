import {
  CrewSchedulingRequestSchema,
  CrewSchedulingResponseSchema,
  SessionObservationResponseSchema,
  VerifyTaskResponseSchema,
} from "./commands.js";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  type RouteConfig,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  ApprovalDecisionRequestSchema,
  ApprovalIdParamsSchema,
  ArtifactIdParamsSchema,
  CancelMissionRequestSchema,
  CapabilitiesResponseSchema,
  CreateCrewRequestSchema,
  CreateCrewResponseSchema,
  CreateMissionRequestSchema,
  CreateMissionResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateTaskRequestSchema,
  CreateTaskResponseSchema,
  GetArtifactResponseSchema,
  GetMissionResponseSchema,
  GetTaskResponseSchema,
  HealthResponseSchema,
  IDEMPOTENCY_HEADER,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  ListCrewsQuerySchema,
  ListCrewsResponseSchema,
  ListEventsQuerySchema,
  ListEventsResponseSchema,
  ListMissionsQuerySchema,
  ListMissionsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksQuerySchema,
  ListTasksResponseSchema,
  MissionIdParamsSchema,
  OperationAcceptedSchema,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  SessionIdParamsSchema,
  SnapshotResponseSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  TaskIdParamsSchema,
  UsageQuerySchema,
  UsageResponseSchema,
} from "./commands.js";
import {
  AgentSchema,
  ApprovalSchema,
  ArtifactSchema,
  CrewMemberSchema,
  CrewSchema,
  MissionSchema,
  ProjectSchema,
  TaskDependencySchema,
  TaskSchema,
  UsageSampleSchema,
  WorktreeSchema,
} from "./entities.js";
import { ApiErrorBodySchema } from "./errors.js";
import { EventEnvelopeSchema } from "./events.js";
import { RuntimeCapabilitiesSchema } from "./runtime.js";
import { PROTOCOL_PACKAGE_VERSION } from "./version.js";

type OpenApiDocument = ReturnType<OpenApiGeneratorV31["generateDocument"]>;

const IdempotencyHeadersSchema = z.object({
  [IDEMPOTENCY_HEADER]: z
    .string()
    .min(1)
    .meta({ description: "Unique key per logical mutation; replays return the original result." }),
});

/**
 * `ListEventsQuerySchema` uses coercion/preprocessing for query strings, which has no
 * OpenAPI equivalent; this is its wire-level description.
 */
const ListEventsQueryDocSchema = z.object({
  cursor: ListEventsQuerySchema.shape.cursor,
  limit: z.number().int().min(1).max(1000).default(200).optional(),
  streamId: ListEventsQuerySchema.shape.streamId,
  missionId: ListEventsQuerySchema.shape.missionId,
  types: z
    .string()
    .optional()
    .meta({ description: "Comma-separated event types (or repeat the parameter)." }),
});

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

const errorResponse = json(ApiErrorBodySchema, "Error");

interface Endpoint {
  method: RouteConfig["method"];
  path: string;
  summary: string;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  status: 200 | 201 | 202;
  response: z.ZodType;
  sse?: boolean;
  /** Raw bytes (content type varies per resource). */
  binary?: boolean;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "get",
    path: "/v1/health",
    summary: "Liveness and runtime health",
    status: 200,
    response: HealthResponseSchema,
  },
  {
    method: "get",
    path: "/v1/capabilities",
    summary: "Server, protocol and runtime capabilities",
    status: 200,
    response: CapabilitiesResponseSchema,
  },
  {
    method: "get",
    path: "/v1/snapshot",
    summary: "Full read model plus a replay cursor",
    status: 200,
    response: SnapshotResponseSchema,
  },
  {
    method: "post",
    path: "/v1/projects",
    summary: "Create a project",
    body: CreateProjectRequestSchema,
    status: 201,
    response: CreateProjectResponseSchema,
  },
  {
    method: "get",
    path: "/v1/projects",
    summary: "List projects",
    status: 200,
    response: ListProjectsResponseSchema,
  },
  {
    method: "post",
    path: "/v1/missions",
    summary: "Create a mission",
    body: CreateMissionRequestSchema,
    status: 201,
    response: CreateMissionResponseSchema,
  },
  {
    method: "get",
    path: "/v1/missions",
    summary: "List missions",
    query: ListMissionsQuerySchema,
    status: 200,
    response: ListMissionsResponseSchema,
  },
  {
    method: "get",
    path: "/v1/missions/{id}",
    summary: "Get a mission with its crews and tasks",
    params: MissionIdParamsSchema,
    status: 200,
    response: GetMissionResponseSchema,
  },
  {
    method: "post",
    path: "/v1/missions/{id}/start",
    summary: "Start a mission",
    params: MissionIdParamsSchema,
    body: StartMissionRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "post",
    path: "/v1/missions/{id}/cancel",
    summary: "Cancel a mission",
    params: MissionIdParamsSchema,
    body: CancelMissionRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "post",
    path: "/v1/crews",
    summary: "Create a crew",
    body: CreateCrewRequestSchema,
    status: 201,
    response: CreateCrewResponseSchema,
  },
  ...(["pause", "resume"] as const).map((action) => ({
    method: "post" as const,
    path: `/v1/crews/{id}/${action}`,
    summary: `${action} crew scheduling (existing sessions continue)`,
    params: z.object({ id: z.string().min(1) }),
    body: CrewSchedulingRequestSchema,
    status: 200 as const,
    response: CrewSchedulingResponseSchema,
  })),
  {
    method: "get",
    path: "/v1/sessions/{id}",
    summary: "Observe a live runtime session",
    params: SessionIdParamsSchema,
    status: 200,
    response: SessionObservationResponseSchema,
  },
  {
    method: "get",
    path: "/v1/tasks/{id}",
    summary: "Inspect a task and its source-owned execution evidence",
    params: TaskIdParamsSchema,
    status: 200,
    response: GetTaskResponseSchema,
  },
  {
    method: "post",
    path: "/v1/tasks/{id}/verify",
    summary: "Record fresh verification evidence without changing acceptance",
    params: TaskIdParamsSchema,
    body: RetryTaskRequestSchema,
    status: 200,
    response: VerifyTaskResponseSchema,
  },
  {
    method: "get",
    path: "/v1/crews",
    summary: "List crews",
    query: ListCrewsQuerySchema,
    status: 200,
    response: ListCrewsResponseSchema,
  },
  {
    method: "get",
    path: "/v1/tasks",
    summary: "List tasks",
    query: ListTasksQuerySchema,
    status: 200,
    response: ListTasksResponseSchema,
  },
  {
    method: "post",
    path: "/v1/tasks",
    summary: "Create a task in a mission",
    body: CreateTaskRequestSchema,
    status: 201,
    response: CreateTaskResponseSchema,
  },
  {
    method: "post",
    path: "/v1/tasks/{id}/retry",
    summary: "Retry a failed or blocked task",
    params: TaskIdParamsSchema,
    body: RetryTaskRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "post",
    path: "/v1/tasks/{id}/pr",
    summary:
      "Request delivery of a completed task (pull request, or a local patch when there is no remote); needs a pr.create approval; never pushes or merges",
    params: TaskIdParamsSchema,
    body: RequestPrRequestSchema,
    status: 202,
    response: RequestPrResponseSchema,
  },
  {
    method: "get",
    path: "/v1/approvals",
    summary: "List approvals",
    query: ListApprovalsQuerySchema,
    status: 200,
    response: ListApprovalsResponseSchema,
  },
  {
    method: "post",
    path: "/v1/approvals/{id}/decision",
    summary: "Approve or reject",
    params: ApprovalIdParamsSchema,
    body: ApprovalDecisionRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/input",
    summary: "Send an instruction to a session",
    params: SessionIdParamsSchema,
    body: SendInstructionRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "post",
    path: "/v1/sessions/{id}/stop",
    summary: "Stop a session",
    params: SessionIdParamsSchema,
    body: StopSessionRequestSchema,
    status: 202,
    response: OperationAcceptedSchema,
  },
  {
    method: "get",
    path: "/v1/events",
    summary: "Replay events from a cursor (ordered per stream)",
    query: ListEventsQueryDocSchema,
    status: 200,
    response: ListEventsResponseSchema,
  },
  {
    method: "get",
    path: "/v1/events/stream",
    summary: "Live events as Server-Sent Events; each `data:` line is one EventEnvelope",
    query: ListEventsQueryDocSchema,
    status: 200,
    response: EventEnvelopeSchema,
    sse: true,
  },
  {
    method: "get",
    path: "/v1/artifacts/{id}",
    summary: "Get an artifact",
    params: ArtifactIdParamsSchema,
    status: 200,
    response: GetArtifactResponseSchema,
  },
  {
    method: "get",
    path: "/v1/artifacts/{id}/content",
    summary:
      "Artifact bytes (Content-Type from the artifact kind, size-capped, served only from Mimir's artifact store)",
    params: ArtifactIdParamsSchema,
    status: 200,
    response: z.string().meta({ format: "binary" }),
    binary: true,
  },
  {
    method: "get",
    path: "/v1/usage",
    summary: "Usage totals and samples",
    query: UsageQuerySchema,
    status: 200,
    response: UsageResponseSchema,
  },
];

/*
 * Shared schemas carry `.meta({ id })` at their definition, which the generator turns into
 * `components.schemas` entries and `$ref`s. (`extendZodWithOpenApi`/`registry.register` is
 * avoided: under plain Node the generator loads its CJS build with a separate Zod instance,
 * so prototype patching does not reach our schemas.) This list documents which are shared.
 */
export const OPENAPI_COMPONENTS: Record<string, z.ZodType> = {
  Project: ProjectSchema,
  Mission: MissionSchema,
  Crew: CrewSchema,
  CrewMember: CrewMemberSchema,
  Task: TaskSchema,
  TaskDependency: TaskDependencySchema,
  Agent: AgentSchema,
  Worktree: WorktreeSchema,
  Artifact: ArtifactSchema,
  Approval: ApprovalSchema,
  UsageSample: UsageSampleSchema,
  EventEnvelope: EventEnvelopeSchema,
  RuntimeCapabilities: RuntimeCapabilitiesSchema,
  OperationAccepted: OperationAcceptedSchema,
  ApiErrorBody: ApiErrorBodySchema,
};

/** Build the OpenAPI 3.1 document for the Mimir HTTP API. Pure; no I/O. */
export function generateOpenApi(): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  for (const e of ENDPOINTS) {
    const request: NonNullable<RouteConfig["request"]> = {};
    if (e.params) request.params = e.params;
    if (e.query) request.query = e.query;
    if (e.method === "post") request.headers = IdempotencyHeadersSchema;
    if (e.body) {
      // Bodies whose fields are all optional (start/cancel/retry) may be omitted.
      const required = !e.body.safeParse({}).success;
      request.body = { required, content: { "application/json": { schema: e.body } } };
    }

    registry.registerPath({
      method: e.method,
      path: e.path,
      summary: e.summary,
      request,
      responses: {
        [e.status]: e.sse
          ? {
              description: "Event stream",
              content: { "text/event-stream": { schema: e.response } },
            }
          : e.binary
            ? {
                description: "Raw content",
                content: { "application/octet-stream": { schema: e.response } },
              }
            : json(e.response, "OK"),
        default: errorResponse,
      },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Mimir API",
      version: PROTOCOL_PACKAGE_VERSION,
      description:
        "Local-first mission control for crews of coding agents. Mutations require the `idempotency-key` header; asynchronous mutations return 202 with an OperationAccepted body.",
    },
    servers: [{ url: "http://127.0.0.1:7700" }],
  });
}

/** JSON Schema (draft 2020-12) for the event envelope. Pure; no I/O. */
export function generateEventEnvelopeJsonSchema(): Record<string, unknown> {
  // An empty metadata registry inlines the envelope instead of emitting a `$ref` to its id.
  return z.toJSONSchema(EventEnvelopeSchema, { io: "output", metadata: z.registry() }) as Record<
    string,
    unknown
  >;
}

/**
 * JSON Schema (draft 2020-12) for any protocol schema; `io` picks the request (`input`) or
 * response (`output`) view. Parts JSON Schema cannot express (transforms) become `{}`. Pure.
 */
export function jsonSchemaOf(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>;
}
