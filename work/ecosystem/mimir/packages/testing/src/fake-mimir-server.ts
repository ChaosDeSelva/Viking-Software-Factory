import { z as schema } from "zod";
import {
  GetTaskResponseSchema,
  CrewSchedulingRequestSchema,
  CrewSchedulingResponseSchema,
  SessionObservationResponseSchema,
  VerifyTaskResponseSchema,
} from "@mimir/protocol";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  AgentSchema,
  ApprovalDecisionRequestSchema,
  ApprovalIdParamsSchema,
  ApprovalSchema,
  ArtifactIdParamsSchema,
  ArtifactSchema,
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
  CrewMemberSchema,
  CrewSchema,
  EventEnvelopeSchema,
  GetArtifactResponseSchema,
  GetMissionResponseSchema,
  HealthResponseSchema,
  IDEMPOTENCY_HEADER,
  ListApprovalsQuerySchema,
  ListApprovalsResponseSchema,
  ListCrewsQuerySchema,
  ListCrewsResponseSchema,
  ListEventsQuerySchema,
  ListMissionsQuerySchema,
  ListMissionsResponseSchema,
  ListProjectsResponseSchema,
  ListTasksQuerySchema,
  ListTasksResponseSchema,
  MimirError,
  MissionIdParamsSchema,
  MissionSchema,
  OperationAcceptedSchema,
  PROTOCOL_VERSION,
  ProjectSchema,
  RequestPrRequestSchema,
  RequestPrResponseSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  SessionIdParamsSchema,
  SnapshotResponseSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  TaskIdParamsSchema,
  TaskSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  UsageSampleSchema,
  artifactContentType,
  isMimirError,
  newId,
  toValidationIssues,
  type Agent,
  type Approval,
  type Artifact,
  type Crew,
  type CrewMember,
  type EventEnvelope,
  type EventType,
  type Mission,
  type MissionStatus,
  type Project,
  type Task,
  type UsageSample,
  type UsageTotals,
} from "@mimir/protocol";
import type { z } from "zod";

/**
 * Wire shape of `GET /v1/events` pages:
 * - `nullWithLastCursor` (default, the real server's shape): `{events, nextCursor, hasMore,
 *   lastCursor}` with `nextCursor: null` on the final page and `lastCursor` always set.
 * - `hasMore` (older server): `{events, nextCursor: <last event's cursor>, hasMore}`, never null.
 * - `legacy` (older server): `{events, nextCursor}` with `nextCursor: null` on the final page.
 */
export type EventsPageShape = "hasMore" | "legacy" | "nullWithLastCursor";

export interface FakeMimirServerOptions {
  /** Bearer token required on every route except `/v1/health`. Default `fake-token`. */
  token?: string;
  /** Port to bind on 127.0.0.1. Default 0 (ephemeral). */
  port?: number;
  /** Default `nullWithLastCursor`. */
  eventsPageShape?: EventsPageShape;
  /**
   * When the client sends no cursor, follow the opening `retry: 3000` block with an id-only block
   * `id: <start cursor>`, as the real server does. Default true; false mimics an older server.
   */
  sseInitialId?: boolean;
  /** SSE heartbeat comment interval. Default 15 000 ms. */
  heartbeatMs?: number;
  /**
   * `POST /v1/tasks/:id/pr` policy: `require_approval` (default, like the real server's default
   * policy) answers `approval_required` and delivers on approval; `allow` delivers at once.
   */
  prPolicy?: "require_approval" | "allow";
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface StoredEvent {
  event: EventEnvelope;
  cursor: string;
}

export type AppendEventInput = Partial<Omit<EventEnvelope, "type">> & { type: EventType };

export interface FakeMimirState {
  projects: Map<string, Project>;
  missions: Map<string, Mission>;
  crews: Map<string, Crew>;
  members: Map<string, CrewMember>;
  tasks: Map<string, Task>;
  agents: Map<string, Agent>;
  approvals: Map<string, Approval>;
  artifacts: Map<string, Artifact>;
  /** Stored bytes per artifact id, served by `GET /v1/artifacts/:id/content` (absent → 404). */
  artifactContent: Map<string, Uint8Array>;
  usage: UsageSample[];
  /** Inputs and stop requests received per session id. */
  sessionCommands: Map<string, unknown[]>;
  /** Terminal text per session id, served by `GET /v1/sessions/:id/terminal`. */
  terminals: Map<string, string>;
}

/** `GET /v1/sessions/:id/terminal` body (provisional, T12; the protocol has no schema yet). */
export interface FakeTerminalRead {
  text: string;
  provenance: "observed";
  capturedAt: string;
}

/** One `GET /v1/attention` item (provisional, T12; the protocol has no schema yet). */
export interface FakeAttentionItem {
  id: string;
  kind: "approval" | "blocked" | "stuck" | "budget" | "unknown";
  title: string;
  detail?: string;
  missionId?: string;
  taskId?: string;
  approvalId?: string;
  sessionId?: string;
}

export interface FakeMimirServer {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly requests: RecordedRequest[];
  readonly state: FakeMimirState;
  /** True when a route exists for `method` + `path` (path params may be any string). */
  handles(method: string, path: string): boolean;
  appendEvent(input: AppendEventInput): StoredEvent;
  events(): StoredEvent[];
  latestCursor(): string;
  /** Drops events up to and including `throughCursor`; older cursors then get 410. */
  prune(throughCursor: string): void;
  seedTask(input: Partial<Task> & Pick<Task, "missionId">): Task;
  seedAgent(input: Partial<Agent> & Pick<Agent, "crewId">): Agent;
  seedApproval(input?: Partial<Approval>): Approval;
  /** Seeds artifact metadata, and its content when given (text is stored as UTF-8). */
  seedArtifact(
    input: Partial<Artifact> & Pick<Artifact, "taskId">,
    content?: string | Uint8Array,
  ): Artifact;
  seedUsageSample(input: Partial<UsageSample> & Pick<UsageSample, "agentId">): UsageSample;
  sseClientCount(): number;
  waitForSseClients(n: number, timeoutMs?: number): Promise<void>;
  /** Sends `event: gap` to every SSE client, then ends its response. */
  sendGap(reason?: string): void;
  /** Destroys every SSE connection without a final frame (network drop). */
  dropSseClients(): void;
  /** Closes the listener and destroys every connection. State is kept. */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  start(): Promise<void>;
  close(): Promise<void>;
}

const encodeCursor = (seq: number) => Buffer.from(String(seq)).toString("base64");

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, "base64").toString("utf8");
  if (!/^(0|[1-9]\d*)$/.test(text) || encodeCursor(Number(text)) !== cursor) {
    throw new MimirError("validation_failed", "malformed cursor", { cursor });
  }
  return Number(text);
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new MimirError("validation_failed", "request validation failed", {
      issues: toValidationIssues(r.error),
    });
  }
  return r.data;
}

const now = () => new Date().toISOString();

/** Mission statuses that accept no new tasks (mirrors `MISSION_TERMINAL_STATUSES` in core). */
const MISSION_TERMINAL: ReadonlySet<MissionStatus> = new Set(["completed", "cancelled", "failed"]);
/** The real server's default when the crew sets no `maxAttemptsPerTask`. */
const DEFAULT_MAX_ATTEMPTS = 3;

interface Reply {
  status: number;
  body: unknown;
}

interface RouteContext {
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  mutation: boolean;
  /** `"stream"`: the handler wrote the response itself (SSE, raw artifact content). */
  handler: (ctx: RouteContext) => Reply | "stream";
}

interface SseClient {
  res: ServerResponse;
  lastSeq: number;
  filter: (e: StoredEvent) => boolean;
  timer: ReturnType<typeof setInterval>;
}

/** An in-memory Mimir HTTP server implementing every path of the protocol's OpenAPI document. */
export async function fakeMimirServer(
  options: FakeMimirServerOptions = {},
): Promise<FakeMimirServer> {
  const token = options.token ?? "fake-token";
  const shape = options.eventsPageShape ?? "nullWithLastCursor";
  const sseInitialId = options.sseInitialId ?? true;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  let port = options.port ?? 0;
  let http: Server | undefined;
  const sockets = new Set<Socket>();
  const sse = new Set<SseClient>();
  const requests: RecordedRequest[] = [];
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  const log: { event: EventEnvelope; seq: number }[] = [];
  const streamSeq = new Map<string, number>();
  let globalSeq = 0;
  let floor = 0;

  const state: FakeMimirState = {
    projects: new Map(),
    missions: new Map(),
    crews: new Map(),
    members: new Map(),
    tasks: new Map(),
    agents: new Map(),
    approvals: new Map(),
    artifacts: new Map(),
    artifactContent: new Map(),
    usage: [],
    sessionCommands: new Map(),
    terminals: new Map(),
  };

  // ---- events --------------------------------------------------------------

  function appendEvent(input: AppendEventInput): StoredEvent {
    const streamId = input.streamId ?? (input.missionId ? `mission:${input.missionId}` : "fake");
    const sequence = (streamSeq.get(streamId) ?? 0) + 1;
    const at = now();
    const event = EventEnvelopeSchema.parse({
      id: newId("evt"),
      schemaVersion: 1,
      occurredAt: at,
      observedAt: at,
      source: "fake-mimir",
      provenance: "observed",
      payload: {},
      ...input,
      streamId,
      sequence,
    });
    streamSeq.set(streamId, sequence);
    globalSeq += 1;
    const stored = { event, seq: globalSeq };
    log.push(stored);
    const out = { event, cursor: encodeCursor(globalSeq) };
    for (const client of sse) sendToClient(client, stored);
    return out;
  }

  function checkCursor(cursor: string): number {
    const seq = decodeCursor(cursor);
    if (seq > globalSeq) throw new MimirError("cursor_expired", "cursor is unknown to this server");
    if (seq < floor)
      throw new MimirError("cursor_expired", "cursor is older than the retained log");
    return seq;
  }

  function eventFilter(q: {
    streamId?: string | undefined;
    missionId?: string | undefined;
    types?: EventType[] | undefined;
  }) {
    return (e: StoredEvent) =>
      (q.streamId === undefined || e.event.streamId === q.streamId) &&
      (q.missionId === undefined || e.event.missionId === q.missionId) &&
      (q.types === undefined || q.types.includes(e.event.type));
  }

  function sendToClient(client: SseClient, entry: { event: EventEnvelope; seq: number }): void {
    if (entry.seq <= client.lastSeq) return;
    client.lastSeq = entry.seq;
    const cursor = encodeCursor(entry.seq);
    if (!client.filter({ event: entry.event, cursor })) return;
    client.res.write(
      `id: ${cursor}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`,
    );
  }

  // ---- routes --------------------------------------------------------------

  const routes: Route[] = [];
  function route(method: string, path: string, handler: Route["handler"]): void {
    const keys: string[] = [];
    const pattern = new RegExp(
      `^${path.replace(/:(\w+)/g, (_m, k: string) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, pattern, keys, mutation: method === "POST", handler });
  }

  const ok = (schema: z.ZodType, body: unknown, status = 200): Reply => ({
    status,
    body: schema.parse(body),
  });
  const accepted = (): Reply =>
    ok(OperationAcceptedSchema, { operationId: newId("op"), commandId: newId("cmd") }, 202);

  function need<T>(map: Map<string, T>, id: string, what: string): T {
    const v = map.get(id);
    if (!v) throw new MimirError("not_found", `${what} not found`, { id });
    return v;
  }

  function bump<T extends { version: number; updatedAt: string }>(e: T, patch: Partial<T>): T {
    return { ...e, ...patch, version: e.version + 1, updatedAt: now() };
  }

  const base = () => {
    const at = now();
    return { createdAt: at, updatedAt: at, version: 1 };
  };

  function usageTotals(samples: UsageSample[]): UsageTotals {
    const totals: UsageTotals = {
      tokens: 0,
      estimatedCost: 0,
      samples: samples.length,
      bySource: { measured: 0, estimated: 0, unavailable: 0 },
    };
    for (const s of samples) {
      totals.tokens += s.tokens ?? 0;
      totals.estimatedCost += s.estimatedCost ?? 0;
      totals.bySource[s.source] += 1;
    }
    return totals;
  }

  route("GET", "/v1/health", () => ok(HealthResponseSchema, { status: "ok" }));
  route("GET", "/v1/capabilities", () =>
    ok(CapabilitiesResponseSchema, {
      serverVersion: "0.0.0-fake",
      protocolVersion: PROTOCOL_VERSION,
      runtime: null,
    }),
  );
  route("GET", "/v1/snapshot", () =>
    ok(SnapshotResponseSchema, {
      projects: [...state.projects.values()],
      missions: [...state.missions.values()],
      crews: [...state.crews.values()],
      tasks: [...state.tasks.values()],
      taskDependencies: [],
      agents: [...state.agents.values()],
      approvals: [...state.approvals.values()],
      worktrees: [],
      usage: usageTotals(state.usage),
      cursor: encodeCursor(globalSeq),
    }),
  );

  route("POST", "/v1/projects", ({ body }) => {
    const req = parse(CreateProjectRequestSchema, body);
    const project = ProjectSchema.parse({
      id: newId("prj"),
      ...base(),
      name: req.name,
      repoPath: req.repoPath,
      settings: req.settings ?? {},
    });
    state.projects.set(project.id, project);
    return ok(CreateProjectResponseSchema, { project }, 201);
  });
  route("GET", "/v1/projects", () =>
    ok(ListProjectsResponseSchema, { projects: [...state.projects.values()] }),
  );

  route("POST", "/v1/missions", ({ body }) => {
    const req = parse(CreateMissionRequestSchema, body);
    need(state.projects, req.projectId, "project");
    const mission = MissionSchema.parse({
      id: newId("msn"),
      ...base(),
      projectId: req.projectId,
      objective: req.objective,
      status: "draft",
    });
    state.missions.set(mission.id, mission);
    appendEvent({
      type: "mission.created",
      missionId: mission.id,
      payload: { projectId: mission.projectId, objective: mission.objective },
    });
    return ok(CreateMissionResponseSchema, { mission }, 201);
  });
  route("GET", "/v1/missions", ({ query }) => {
    const q = parse(ListMissionsQuerySchema, query);
    const missions = [...state.missions.values()].filter(
      (m) =>
        (q.projectId === undefined || m.projectId === q.projectId) &&
        (q.status === undefined || m.status === q.status),
    );
    return ok(ListMissionsResponseSchema, { missions });
  });
  route("GET", "/v1/missions/:id", ({ params }) => {
    const { id } = parse(MissionIdParamsSchema, params);
    const mission = need(state.missions, id, "mission");
    return ok(GetMissionResponseSchema, {
      mission,
      crews: [...state.crews.values()].filter((c) => c.missionId === id),
      tasks: [...state.tasks.values()].filter((t) => t.missionId === id),
    });
  });

  function transitionMission(
    id: string,
    allowed: MissionStatus[],
    to: "active" | "cancelled",
    expectedVersion: number | undefined,
    reason?: string,
  ): Reply {
    const mission = need(state.missions, id, "mission");
    if (expectedVersion !== undefined && expectedVersion !== mission.version) {
      throw new MimirError("conflict", "version mismatch", {
        expectedVersion,
        version: mission.version,
      });
    }
    if (!allowed.includes(mission.status)) {
      throw new MimirError("invalid_transition", `mission is ${mission.status}`, {
        from: mission.status,
        to,
      });
    }
    state.missions.set(id, bump(mission, { status: to }));
    appendEvent({
      type: to === "active" ? "mission.started" : "mission.cancelled",
      missionId: mission.id,
      payload: { from: mission.status, to, ...(reason !== undefined ? { reason } : {}) },
    });
    return accepted();
  }

  route("POST", "/v1/missions/:id/start", ({ params, body }) => {
    const { id } = parse(MissionIdParamsSchema, params);
    const req = parse(StartMissionRequestSchema, body ?? {});
    return transitionMission(id, ["draft", "paused"], "active", req.expectedVersion);
  });
  route("POST", "/v1/missions/:id/cancel", ({ params, body }) => {
    const { id } = parse(MissionIdParamsSchema, params);
    const req = parse(CancelMissionRequestSchema, body ?? {});
    return transitionMission(
      id,
      ["draft", "active", "paused"],
      "cancelled",
      req.expectedVersion,
      req.reason,
    );
  });

  route("POST", "/v1/crews", ({ body }) => {
    const req = parse(CreateCrewRequestSchema, body);
    need(state.missions, req.missionId, "mission");
    const crew = CrewSchema.parse({
      id: newId("crw"),
      ...base(),
      missionId: req.missionId,
      template: req.template,
      status: "configured",
      limits: req.limits ?? {},
    });
    const members = req.members.map((m, i) =>
      CrewMemberSchema.parse({
        id: newId("cmb"),
        ...base(),
        crewId: crew.id,
        role: m.role,
        agentKind: m.agentKind,
        name: m.name ?? `${m.role}-${i + 1}`,
      }),
    );
    state.crews.set(crew.id, crew);
    for (const m of members) state.members.set(m.id, m);
    return ok(CreateCrewResponseSchema, { crew, members }, 201);
  });
  route("GET", "/v1/crews", ({ query }) => {
    const q = parse(ListCrewsQuerySchema, query);
    const crews = [...state.crews.values()].filter(
      (c) => q.missionId === undefined || c.missionId === q.missionId,
    );
    return ok(ListCrewsResponseSchema, { crews });
  });

  for (const action of ["pause", "resume"] as const) {
    route("POST", `/v1/crews/:id/${action}`, ({ params, body }) => {
      const { id } = parse(schema.object({ id: schema.string().min(1) }), params);
      const request = parse(CrewSchedulingRequestSchema, body ?? {});
      const crew = need(state.crews, id, "crew");
      const mission = need(state.missions, crew.missionId, "mission");
      if (MISSION_TERMINAL.has(mission.status))
        throw new MimirError("invalid_transition", "mission is terminal");
      if (request.expectedVersion !== undefined && request.expectedVersion !== crew.version)
        throw new MimirError("conflict", "crew version changed");
      const paused = action === "pause";
      if (!!crew.schedulingPaused !== paused) {
        state.crews.set(id, bump(crew, { schedulingPaused: paused }));
        appendEvent({
          type: "crew.scheduling_changed",
          streamId: `crew:${id}`,
          crewId: crew.id,
          missionId: crew.missionId,
          payload: { crewId: id, paused },
        });
      }
      return ok(CrewSchedulingResponseSchema, {
        crew: state.crews.get(id),
        semantics: "Scheduling only. Existing agent sessions continue.",
      });
    });
  }
  route("GET", "/v1/tasks/:id", ({ params }) => {
    const { id } = parse(TaskIdParamsSchema, params);
    const task = need(state.tasks, id, "task");
    return ok(GetTaskResponseSchema, {
      task,
      spec: {},
      mission: state.missions.get(task.missionId) ?? null,
      dependencies: [],
      sessions: [],
      worktrees: [],
      artifacts: [...state.artifacts.values()].filter((a) => a.taskId === id),
      approvals: [...state.approvals.values()].filter((a) => a.taskId === id),
    });
  });
  route("POST", "/v1/tasks/:id/verify", ({ params, body }) => {
    const { id } = parse(TaskIdParamsSchema, params);
    const request = parse(RetryTaskRequestSchema, body ?? {});
    const task = need(state.tasks, id, "task");
    if (request.expectedVersion !== undefined && request.expectedVersion !== task.version)
      throw new MimirError("conflict", "task version changed");
    if (!["completed", "failed"].includes(task.status))
      throw new MimirError("invalid_transition", "recheck requires a settled task");
    // Fixture evidence is explicitly unsuccessful; it never certifies real work.
    const artifactId = newId("art");
    const content = Buffer.from(
      JSON.stringify({ passed: false, reason: "Fake server does not execute verification" }),
    );
    state.artifacts.set(
      artifactId,
      ArtifactSchema.parse({
        id: artifactId,
        ...base(),
        taskId: id,
        kind: "file",
        uri: "fixture:verification",
        hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      }),
    );
    state.artifactContent.set(artifactId, content);
    return ok(VerifyTaskResponseSchema, {
      artifactId,
      passed: false,
      semantics: "Fixture only. Task acceptance is unchanged.",
    });
  });
  route("GET", "/v1/sessions/:id", ({ params }) => {
    const { id } = parse(SessionIdParamsSchema, params);
    const agent = [...state.agents.values()].find((a) => a.runtimeSessionId === id);
    if (!agent) throw new MimirError("not_found", "session not found");
    return ok(SessionObservationResponseSchema, {
      session: null,
      persisted: { id, taskId: agent.taskId, crewId: agent.crewId },
      observedAt: null,
      available: false,
    });
  });

  route("GET", "/v1/tasks", ({ query }) => {
    const q = parse(ListTasksQuerySchema, query);
    const tasks = [...state.tasks.values()].filter(
      (t) =>
        (q.missionId === undefined || t.missionId === q.missionId) &&
        (q.crewId === undefined || t.crewId === q.crewId) &&
        (q.status === undefined || t.status === q.status),
    );
    return ok(ListTasksResponseSchema, { tasks });
  });
  // Mirrors the real server: 422 unknown mission/crew/dependency, 409 duplicate id or a mission
  // that is already terminal; the task starts `pending` at version 0.
  route("POST", "/v1/tasks", ({ body }) => {
    const { missionId, ...input } = parse(CreateTaskRequestSchema, body);
    const mission = state.missions.get(missionId);
    if (!mission) {
      throw new MimirError("validation_failed", `mission ${missionId} not found`, {
        reason: "unknown_mission",
        missionId,
      });
    }
    if (MISSION_TERMINAL.has(mission.status)) {
      throw new MimirError("invalid_transition", `mission is ${mission.status}`, {
        missionId,
        status: mission.status,
      });
    }
    const id = input.id ?? newId("tsk");
    if (state.tasks.has(id)) {
      throw new MimirError("conflict", `task ${id} already exists`, { taskId: id });
    }
    for (const dep of input.dependsOn ?? []) {
      if (state.tasks.get(dep)?.missionId !== missionId) {
        throw new MimirError(
          "validation_failed",
          `dependency ${dep} is not a task of this mission`,
          {
            reason: "unknown_dependency",
            index: 0,
            dependsOn: dep,
          },
        );
      }
    }
    const crew = input.crewId === undefined ? undefined : state.crews.get(input.crewId);
    if (input.crewId !== undefined && crew?.missionId !== missionId) {
      throw new MimirError(
        "validation_failed",
        `crew ${input.crewId} is not a crew of this mission`,
        {
          reason: "unknown_crew",
          index: 0,
          crewId: input.crewId,
        },
      );
    }
    const at = now();
    const task = TaskSchema.parse({
      id,
      missionId,
      crewId: input.crewId ?? null,
      title: input.title,
      acceptance: (input.acceptanceCriteria ?? []).join("\n"),
      status: "pending",
      attempt: 0,
      maxAttempts: crew?.limits.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS,
      agentId: null,
      leaseExpiresAt: null,
      createdAt: at,
      updatedAt: at,
      version: 0,
    });
    state.tasks.set(id, task);
    appendEvent({
      type: "task.created",
      streamId: `task:${id}`,
      taskId: task.id,
      missionId,
      ...(task.crewId !== null ? { crewId: task.crewId } : {}),
      payload: {
        missionId,
        crewId: task.crewId,
        title: task.title,
        acceptance: task.acceptance,
        dependsOn: input.dependsOn ?? [],
        brief: input.brief,
        ...(input.argv !== undefined ? { argv: input.argv } : {}),
      },
    });
    return ok(CreateTaskResponseSchema, { task }, 201);
  });
  route("POST", "/v1/tasks/:id/retry", ({ params, body }) => {
    const { id } = parse(TaskIdParamsSchema, params);
    const req = parse(RetryTaskRequestSchema, body ?? {});
    const task = need(state.tasks, id, "task");
    if (req.expectedVersion !== undefined && req.expectedVersion !== task.version) {
      throw new MimirError("conflict", "version mismatch");
    }
    if (!["failed", "blocked", "cancelled"].includes(task.status)) {
      throw new MimirError("invalid_transition", `task is ${task.status}`);
    }
    const next = bump(task, { status: "ready", attempt: task.attempt + 1 });
    state.tasks.set(id, next);
    appendEvent({
      type: "task.retried",
      missionId: task.missionId,
      taskId: task.id,
      payload: {
        from: task.status,
        to: "ready",
        attempt: next.attempt,
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      },
    });
    return accepted();
  });

  // Mirrors the real server: a completed task needs a `pr.create` approval (unless `prPolicy` is
  // `allow`); approving it records a `local_delivery` artifact (the fake has no remote) and
  // consumes the approval, so a later request asks again.
  const pendingPrApproval = (taskId: string) =>
    [...state.approvals.values()].find(
      (a) => a.action === "pr.create" && a.taskId === taskId && a.status === "pending",
    );
  function recordLocalDelivery(task: Task): void {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ branch: `mimir/fake/${task.id}`, patch: "" }),
    );
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const artifact = ArtifactSchema.parse({
      id: newId("art"),
      ...base(),
      taskId: task.id,
      kind: "local_delivery",
      uri: `mimir://artifacts/${task.id}`,
      hash,
    });
    state.artifacts.set(artifact.id, artifact);
    state.artifactContent.set(artifact.id, bytes);
    appendEvent({
      type: "artifact.recorded",
      missionId: task.missionId,
      taskId: task.id,
      payload: {
        artifactId: artifact.id,
        taskId: task.id,
        kind: artifact.kind,
        uri: artifact.uri,
        hash,
        bytes: bytes.byteLength,
      },
    });
  }
  route("POST", "/v1/tasks/:id/pr", ({ params, body }) => {
    const { id } = parse(TaskIdParamsSchema, params);
    parse(RequestPrRequestSchema, body ?? {});
    const task = need(state.tasks, id, "task");
    if (task.status !== "completed") {
      throw new MimirError("invalid_transition", "only a completed task can be delivered", {
        taskId: id,
        status: task.status,
      });
    }
    const op = { operationId: newId("op"), commandId: newId("cmd") };
    if (options.prPolicy === "allow") {
      recordLocalDelivery(task);
      return ok(RequestPrResponseSchema, { ...op, status: "delivered" }, 202);
    }
    let approval = pendingPrApproval(id);
    if (!approval) {
      approval = ApprovalSchema.parse({
        id: newId("apr"),
        ...base(),
        action: "pr.create",
        status: "pending",
        actor: null,
        expiry: null,
        missionId: task.missionId,
        taskId: id,
        reason: null,
      });
      state.approvals.set(approval.id, approval);
      appendEvent({
        type: "approval.requested",
        missionId: task.missionId,
        taskId: id,
        payload: {
          approvalId: approval.id,
          action: "pr.create",
          expiry: null,
          requestedBy: { kind: "system", id: "mimir" },
        },
      });
    }
    return ok(
      RequestPrResponseSchema,
      { ...op, status: "approval_required", approvalId: approval.id },
      202,
    );
  });

  route("GET", "/v1/approvals", ({ query }) => {
    const q = parse(ListApprovalsQuerySchema, query);
    const approvals = [...state.approvals.values()].filter(
      (a) =>
        (q.status === undefined || a.status === q.status) &&
        (q.missionId === undefined || a.missionId === q.missionId),
    );
    return ok(ListApprovalsResponseSchema, { approvals });
  });
  route("POST", "/v1/approvals/:id/decision", ({ params, body }) => {
    const { id } = parse(ApprovalIdParamsSchema, params);
    const req = parse(ApprovalDecisionRequestSchema, body);
    const approval = need(state.approvals, id, "approval");
    if (approval.status !== "pending") {
      throw new MimirError("invalid_transition", `approval is ${approval.status}`);
    }
    state.approvals.set(
      id,
      bump(approval, { status: req.decision, actor: "local", reason: req.reason ?? null }),
    );
    appendEvent({
      type: "approval.decided",
      ...(approval.missionId ? { missionId: approval.missionId } : { streamId: "approvals" }),
      payload: {
        approvalId: approval.id,
        decision: req.decision,
        actor: "local",
        ...(req.reason !== undefined ? { reason: req.reason } : {}),
      },
    });
    const prTask =
      approval.action === "pr.create" && approval.taskId
        ? state.tasks.get(approval.taskId)
        : undefined;
    if (req.decision === "approved" && prTask) {
      recordLocalDelivery(prTask);
      appendEvent({
        type: "approval.consumed",
        ...(approval.missionId ? { missionId: approval.missionId } : { streamId: "approvals" }),
        payload: { approvalId: approval.id },
      });
    }
    return accepted();
  });

  function sessionCommand(id: string, command: unknown): Reply {
    const known = [...state.agents.values()].some((a) => a.runtimeSessionId === id);
    if (!known) throw new MimirError("not_found", "session not found", { id });
    const list = state.sessionCommands.get(id) ?? [];
    list.push(command);
    state.sessionCommands.set(id, list);
    return accepted();
  }
  route("POST", "/v1/sessions/:id/input", ({ params, body }) => {
    const { id } = parse(SessionIdParamsSchema, params);
    return sessionCommand(id, { input: parse(SendInstructionRequestSchema, body) });
  });
  route("POST", "/v1/sessions/:id/stop", ({ params, body }) => {
    const { id } = parse(SessionIdParamsSchema, params);
    return sessionCommand(id, { stop: parse(StopSessionRequestSchema, body) });
  });

  // T12 routes not yet in the protocol's OpenAPI document (provisional shapes).
  route("GET", "/v1/sessions/:id/terminal", ({ params, query }) => {
    const { id } = parse(SessionIdParamsSchema, params);
    const raw = query["lines"];
    let lines = 200;
    if (raw !== undefined) {
      const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 10_000) {
        throw new MimirError("validation_failed", "lines must be an integer 1..10000", {
          issues: [{ path: ["lines"], message: "expected an integer 1..10000" }],
        });
      }
      lines = n;
    }
    const known = [...state.agents.values()].some((a) => a.runtimeSessionId === id);
    if (!known) throw new MimirError("not_found", "session not found", { id });
    const text = (state.terminals.get(id) ?? "").split("\n").slice(-lines).join("\n");
    const body: FakeTerminalRead = { text, provenance: "observed", capturedAt: now() };
    return { status: 200, body };
  });
  route("GET", "/v1/attention", () => {
    const items: FakeAttentionItem[] = [];
    for (const a of state.approvals.values()) {
      if (a.status !== "pending") continue;
      items.push({
        id: `attention:${a.id}`,
        kind: "approval",
        title: `Approval needed: ${a.action}`,
        approvalId: a.id,
        ...(a.missionId ? { missionId: a.missionId } : {}),
        ...(a.taskId ? { taskId: a.taskId } : {}),
      });
    }
    for (const t of state.tasks.values()) {
      if (t.status !== "blocked") continue;
      items.push({
        id: `attention:${t.id}`,
        kind: "blocked",
        title: `Task blocked: ${t.title}`,
        ...(t.blockedReason ? { detail: t.blockedReason } : {}),
        missionId: t.missionId,
        taskId: t.id,
      });
    }
    return { status: 200, body: { items } };
  });

  route("GET", "/v1/events", ({ query }) => {
    const q = parse(ListEventsQuerySchema, query);
    const after = q.cursor === undefined ? floor : checkCursor(q.cursor);
    const filter = eventFilter(q);
    const matching = log
      .filter((e) => e.seq > after)
      .map((e) => ({ event: e.event, cursor: encodeCursor(e.seq) }))
      .filter(filter);
    const page = matching.slice(0, q.limit);
    const hasMore = matching.length > page.length;
    const last = page.at(-1)?.cursor ?? q.cursor ?? null;
    const events = page.map((e) => e.event);
    if (shape === "legacy") {
      return { status: 200, body: { events, nextCursor: hasMore ? last : null } };
    }
    if (shape === "nullWithLastCursor") {
      const lastCursor = last ?? encodeCursor(floor);
      return {
        status: 200,
        body: { events, nextCursor: hasMore ? last : null, hasMore, lastCursor },
      };
    }
    return { status: 200, body: { events, nextCursor: last, hasMore } };
  });

  route("GET", "/v1/events/stream", ({ query, req, res }) => {
    const q = parse(ListEventsQuerySchema, query);
    const header = req.headers["last-event-id"];
    const start = typeof header === "string" && header.trim() !== "" ? header.trim() : q.cursor;
    const afterSeq = start === undefined ? globalSeq : checkCursor(start);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    // Like the real server: without a client cursor, pin the start with an id-only block after
    // the `retry:` block (same bytes as the server's two writes, sent as one chunk here).
    const pin = sseInitialId && start === undefined ? `id: ${encodeCursor(afterSeq)}\n\n` : "";
    res.write(`retry: 3000\n\n${pin}`);
    const client: SseClient = {
      res,
      lastSeq: afterSeq,
      filter: eventFilter(q),
      timer: setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs),
    };
    client.timer.unref();
    sse.add(client);
    res.on("close", () => {
      clearInterval(client.timer);
      sse.delete(client);
    });
    for (const entry of log) sendToClient(client, entry);
    return "stream";
  });

  route("GET", "/v1/artifacts/:id", ({ params }) => {
    const { id } = parse(ArtifactIdParamsSchema, params);
    return ok(GetArtifactResponseSchema, { artifact: need(state.artifacts, id, "artifact") });
  });
  // Raw bytes like the real server: Content-Type from the kind, the hash in `x-artifact-hash`;
  // metadata without stored content (pruned) is 404. The response is written here directly.
  route("GET", "/v1/artifacts/:id/content", ({ params, res }) => {
    const { id } = parse(ArtifactIdParamsSchema, params);
    const artifact = need(state.artifacts, id, "artifact");
    const bytes = state.artifactContent.get(id);
    if (!bytes) {
      throw new MimirError("not_found", `artifact ${id} content is not available`, {
        artifactId: id,
      });
    }
    res.writeHead(200, {
      "content-type": artifactContentType(artifact.kind),
      "content-length": String(bytes.byteLength),
      "x-artifact-hash": artifact.hash,
      "x-content-type-options": "nosniff",
    });
    res.end(bytes);
    return "stream";
  });
  route("GET", "/v1/usage", ({ query }) => {
    const q = parse(UsageQuerySchema, query);
    const samples = state.usage.filter((s) => {
      if (q.agentId !== undefined && s.agentId !== q.agentId) return false;
      if (q.missionId === undefined) return true;
      const agent = state.agents.get(s.agentId);
      const crew = agent ? state.crews.get(agent.crewId) : undefined;
      return crew?.missionId === q.missionId;
    });
    return ok(UsageResponseSchema, { totals: usageTotals(samples), samples });
  });

  // ---- HTTP plumbing ---------------------------------------------------------

  function match(
    method: string,
    path: string,
  ): { route: Route; params: Record<string, string> } | undefined {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? "")));
      return { route: r, params };
    }
    return undefined;
  }

  function send(res: ServerResponse, reply: Reply, headers: Record<string, string> = {}): void {
    res.writeHead(reply.status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(reply.body));
  }

  function errorReply(err: unknown): Reply {
    const e = isMimirError(err) ? err : new MimirError("internal", "internal error");
    return { status: e.status, body: e.toBody() };
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MimirError("validation_failed", "body is not valid JSON");
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake.local");
    const method = req.method ?? "GET";
    let body: unknown;
    try {
      body = await readBody(req);
    } catch (err) {
      send(res, errorReply(err));
      return;
    }
    requests.push({ method, url: url.pathname + url.search, headers: req.headers, body });
    try {
      const found = match(method, url.pathname);
      if (!found) throw new MimirError("not_found", `no route ${method} ${url.pathname}`);
      if (url.pathname !== "/v1/health" && req.headers.authorization !== `Bearer ${token}`) {
        throw new MimirError("unauthorized", "missing or invalid bearer token");
      }
      const query: Record<string, string | string[]> = {};
      for (const key of new Set(url.searchParams.keys())) {
        const all = url.searchParams.getAll(key);
        query[key] = all.length === 1 ? (all[0] as string) : all;
      }
      const ctx: RouteContext = { params: found.params, query, body, req, res };
      if (!found.route.mutation) {
        const reply = found.route.handler(ctx);
        if (reply !== "stream") send(res, reply);
        return;
      }
      const key = req.headers[IDEMPOTENCY_HEADER];
      if (typeof key !== "string" || key === "") {
        throw new MimirError("validation_failed", `missing ${IDEMPOTENCY_HEADER} header`);
      }
      const hash = `${method} ${url.pathname} ${JSON.stringify(body ?? null)}`;
      const prior = idempotency.get(key);
      if (prior) {
        if (prior.hash !== hash) {
          throw new MimirError(
            "idempotency_replay_mismatch",
            "key reused with a different request",
          );
        }
        send(res, prior.reply, { "idempotency-replayed": "true" });
        return;
      }
      const reply = found.route.handler(ctx);
      if (reply === "stream") return;
      idempotency.set(key, { hash, reply });
      send(res, reply);
    } catch (err) {
      send(res, errorReply(err));
    }
  }

  async function start(): Promise<void> {
    const srv = createServer((req, res) => void handle(req, res));
    srv.on("connection", (s: Socket) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => {
        srv.off("error", reject);
        resolve();
      });
    });
    const addr = srv.address();
    if (addr && typeof addr === "object") port = addr.port;
    http = srv;
  }

  async function stop(): Promise<void> {
    const srv = http;
    http = undefined;
    for (const c of sse) clearInterval(c.timer);
    sse.clear();
    if (!srv) return;
    const closed = new Promise<void>((resolve) => srv.close(() => resolve()));
    for (const s of sockets) s.destroy();
    sockets.clear();
    await closed;
  }

  await start();

  return {
    get url() {
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      return port;
    },
    token,
    requests,
    state,
    handles: (method, path) => match(method, path) !== undefined,
    appendEvent,
    events: () => log.map((e) => ({ event: e.event, cursor: encodeCursor(e.seq) })),
    latestCursor: () => encodeCursor(globalSeq),
    prune(throughCursor) {
      const seq = decodeCursor(throughCursor);
      floor = Math.max(floor, seq);
      for (let i = log.length - 1; i >= 0; i--)
        if ((log[i] as { seq: number }).seq <= seq) log.splice(i, 1);
    },
    seedTask(input) {
      const task = TaskSchema.parse({
        id: newId("tsk"),
        ...base(),
        crewId: null,
        title: "task",
        acceptance: "",
        status: "pending",
        attempt: 0,
        maxAttempts: 3,
        agentId: null,
        leaseExpiresAt: null,
        ...input,
      });
      state.tasks.set(task.id, task);
      return task;
    },
    seedAgent(input) {
      const agent = AgentSchema.parse({
        id: newId("agt"),
        ...base(),
        role: "implementer",
        agentKind: "fake",
        runtimeSessionId: newId("ses"),
        status: "running",
        taskId: null,
        ...input,
      });
      state.agents.set(agent.id, agent);
      return agent;
    },
    seedApproval(input = {}) {
      const approval = ApprovalSchema.parse({
        id: newId("apr"),
        ...base(),
        action: "git.push",
        status: "pending",
        actor: null,
        expiry: null,
        missionId: null,
        taskId: null,
        reason: null,
        ...input,
      });
      state.approvals.set(approval.id, approval);
      return approval;
    },
    seedArtifact(input, content) {
      const artifact = ArtifactSchema.parse({
        id: newId("art"),
        ...base(),
        kind: "diff",
        uri: "file:///dev/null",
        hash: "sha256:0",
        ...input,
      });
      state.artifacts.set(artifact.id, artifact);
      if (content !== undefined) {
        state.artifactContent.set(
          artifact.id,
          typeof content === "string" ? new TextEncoder().encode(content) : content,
        );
      }
      return artifact;
    },
    seedUsageSample(input) {
      const sample = UsageSampleSchema.parse({
        id: newId("usg"),
        ...base(),
        tokens: 0,
        estimatedCost: 0,
        source: "measured",
        ...input,
      });
      state.usage.push(sample);
      return sample;
    },
    sseClientCount: () => sse.size,
    async waitForSseClients(n, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (sse.size < n) {
        if (Date.now() > deadline) throw new Error(`waitForSseClients: ${sse.size} < ${n}`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    sendGap(reason = "slow_consumer") {
      for (const c of [...sse]) {
        const data = { reason, lastEventId: encodeCursor(c.lastSeq) };
        c.res.end(`event: gap\ndata: ${JSON.stringify(data)}\n\n`);
        clearInterval(c.timer);
        sse.delete(c);
      }
    },
    dropSseClients() {
      for (const c of [...sse]) {
        clearInterval(c.timer);
        sse.delete(c);
        c.res.socket?.destroy();
      }
    },
    stop,
    start,
    close: stop,
  };
}
