/**
 * In-memory fake of Mimir's `/v1` HTTP + SSE API for Sindri tests.
 *
 * Every request body, query and path id is validated with the `@mimir/protocol` schemas, and
 * every response is parsed through the protocol response schema before it is sent. Events are
 * built with `parseEvent`, so a payload that the protocol would reject never reaches a client.
 *
 * Task progressions are scripted per task title (see `TaskStep`). The fake is not Mimir: there
 * is no scheduler, policy engine or runtime; it only emits the event sequences Mimir documents.
 *
 * Artifacts use Mimir's standardised kinds. Their bytes are served at
 * `GET /v1/artifacts/:id/content` with the `x-artifact-hash` header. The `changed-files`
 * manifest carries the task's `headSha` (`FakeMimir.headShaOf`), as Mimir's server records it.
 * The fake never emits `git.commit_observed`: real Mimir does not.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
  MimirError,
  MissionIdParamsSchema,
  OperationAcceptedSchema,
  RetryTaskRequestSchema,
  SendInstructionRequestSchema,
  SessionIdParamsSchema,
  SnapshotResponseSchema,
  StartMissionRequestSchema,
  StopSessionRequestSchema,
  TaskIdParamsSchema,
  UsageQuerySchema,
  UsageResponseSchema,
  artifactContentType,
  newId,
  parseEvent,
  type Approval,
  type Artifact,
  type Crew,
  type CrewMember,
  type EventEnvelope,
  type EventType,
  type Mission,
  type MissionId,
  type Project,
  type SessionId,
  type Task,
  type TaskId,
} from "@mimir/protocol";
import { z } from "zod";

/** One scripted outcome for one attempt of a task. */
export type TaskStep =
  | {
      kind: "complete";
      /** Artifact kinds recorded before `task.completed`. Default test.output, diff, changed-files. */
      artifacts?: string[];
      /** Content per artifact kind; defaults are generated (`changed-files` carries `headSha`). */
      contents?: Record<string, string | ((taskId: string) => string)>;
    }
  | { kind: "fail"; reason?: string; retryable?: boolean }
  | { kind: "approval"; action: string; reason?: string };

export interface FakeMimirOptions {
  token?: string;
  /** Delay between scripted events. Default 1 ms. */
  stepDelayMs?: number;
  heartbeatMs?: number;
  /**
   * Scripts keyed by task title, or by the title's prefix before the first `:`. A task runs its
   * steps in order, one per attempt or approval; when they run out it completes.
   */
  scripts?: Record<string, TaskStep[]>;
}

export interface FakeMimirRequest {
  method: string;
  path: string;
  idempotencyKey?: string;
  body?: unknown;
}

export interface FakeMimir {
  readonly url: string;
  readonly token: string;
  /** `METHOD /path` for every route the fake serves. */
  readonly routes: readonly string[];
  /** Entities really created (idempotent replays do not count). */
  readonly creates: { projects: number; missions: number; crews: number; tasks: number };
  readonly requests: FakeMimirRequest[];
  /** Commands sent to sessions (`input`, `stop`). */
  readonly sessionCommands: { sessionId: string; kind: "input" | "stop"; body: unknown }[];
  script(titleOrPrefix: string, steps: TaskStep[]): void;
  /** Appends an event (validated with `parseEvent`) without changing any entity. */
  inject(
    type: EventType,
    payload: unknown,
    refs: { missionId: MissionId; taskId?: TaskId; sessionId?: string },
  ): void;
  /** The next request matching method + path prefix fails with HTTP `status` (default 500). */
  failNext(method: string, pathPrefix: string, status?: number): void;
  events(): EventEnvelope[];
  /** The cursor positioned after the `n`th event (0 = before the first). */
  cursorAt(n: number): string;
  latestCursor(): string;
  tasks(): Task[];
  approvals(): Approval[];
  artifacts(): Artifact[];
  /** The head commit the fake's `changed-files` manifest records for a task. */
  headShaOf(taskId: string): string;
  /** Replaces an artifact's stored bytes without updating its recorded hash (integrity tests). */
  tamper(artifactId: string, content: string): void;
  waitForSseClients(n: number): Promise<void>;
  /** Ends every open SSE response (clients should reconnect). */
  dropSseClients(): void;
  /** Closes the listener and every socket; state is kept. */
  stop(): Promise<void>;
  /** Listens again on the same port. */
  start(): Promise<void>;
  close(): Promise<void>;
}

const encodeCursor = (seq: number) => Buffer.from(String(seq)).toString("base64");
function decodeCursor(cursor: string): number {
  const n = Number(Buffer.from(cursor, "base64").toString("utf8"));
  if (!Number.isInteger(n) || n < 0) throw new MimirError("validation_failed", "bad cursor");
  return n;
}

interface Reply {
  status: number;
  body: unknown;
  /** Send `body` (a string) as-is with these headers instead of JSON. */
  raw?: Record<string, string>;
}

interface SseClient {
  res: ServerResponse;
  missionId: string | undefined;
  types: Set<string> | undefined;
  timer: NodeJS.Timeout;
}

interface TaskState {
  task: Task;
  dependsOn: TaskId[];
  steps: TaskStep[];
  sessionId: SessionId | null;
  agentId: string | null;
}

const ROUTES = [
  "GET /v1/health",
  "GET /v1/capabilities",
  "GET /v1/snapshot",
  "GET /v1/projects",
  "POST /v1/projects",
  "GET /v1/missions",
  "POST /v1/missions",
  "GET /v1/missions/{id}",
  "POST /v1/missions/{id}/start",
  "POST /v1/missions/{id}/cancel",
  "GET /v1/crews",
  "POST /v1/crews",
  "GET /v1/tasks",
  "POST /v1/tasks",
  "POST /v1/tasks/{id}/retry",
  "GET /v1/approvals",
  "POST /v1/approvals/{id}/decision",
  "POST /v1/sessions/{id}/input",
  "POST /v1/sessions/{id}/stop",
  "GET /v1/events",
  "GET /v1/events/stream",
  "GET /v1/artifacts/{id}",
  "GET /v1/artifacts/{id}/content",
  "GET /v1/usage",
] as const;

function parseWith<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new MimirError("validation_failed", `invalid ${where}`, {
      issues: r.error.issues.map((i) => ({
        path: i.path.map(String),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return r.data;
}

/** Boots a fake Mimir on 127.0.0.1 (ephemeral port). */
export async function createFakeMimir(options: FakeMimirOptions = {}): Promise<FakeMimir> {
  const token = options.token ?? "fake-mimir-token";
  const stepDelayMs = options.stepDelayMs ?? 1;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const scripts = new Map<string, TaskStep[]>(Object.entries(options.scripts ?? {}));

  const projects = new Map<string, Project>();
  const missions = new Map<string, Mission>();
  const crews = new Map<string, { crew: Crew; members: CrewMember[] }>();
  const tasks = new Map<string, TaskState>();
  const approvals = new Map<string, Approval>();
  const artifacts = new Map<string, Artifact>();
  const artifactBytes = new Map<string, string>();
  const headShaOf = (taskId: string) => createHash("sha1").update(`head:${taskId}`).digest("hex");
  const sessions = new Map<string, TaskId>();
  const log: { event: EventEnvelope; seq: number }[] = [];
  const streamSeq = new Map<string, number>();
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  const failures: { method: string; prefix: string; status: number }[] = [];
  const sseClients = new Set<SseClient>();
  const sockets = new Set<Socket>();
  const creates = { projects: 0, missions: 0, crews: 0, tasks: 0 };
  const requests: FakeMimirRequest[] = [];
  const sessionCommands: FakeMimir["sessionCommands"] = [];
  let seq = 0;
  let pending: Promise<void> = Promise.resolve();

  const now = () => new Date().toISOString();
  const base = <I extends string>(id: I) => ({
    id,
    createdAt: now(),
    updatedAt: now(),
    version: 0,
  });
  const touch = <T extends { updatedAt: string; version: number }>(e: T): T => {
    e.updatedAt = now();
    e.version += 1;
    return e;
  };

  function emit(
    type: EventType,
    payload: unknown,
    refs: { missionId: MissionId; taskId?: TaskId; crewId?: string | null; sessionId?: string },
  ): void {
    const streamId = refs.taskId ? `task:${refs.taskId}` : `mission:${refs.missionId}`;
    const sequence = streamSeq.get(streamId) ?? 0;
    streamSeq.set(streamId, sequence + 1);
    const event = parseEvent({
      id: newId("evt"),
      schemaVersion: 1,
      streamId,
      sequence,
      occurredAt: now(),
      observedAt: now(),
      type,
      source: "fake-mimir",
      provenance: "observed",
      missionId: refs.missionId,
      ...(refs.crewId ? { crewId: refs.crewId } : {}),
      ...(refs.taskId ? { taskId: refs.taskId } : {}),
      ...(refs.sessionId ? { sessionId: refs.sessionId } : {}),
      payload,
    }) as EventEnvelope;
    seq += 1;
    const entry = { event, seq };
    log.push(entry);
    for (const c of sseClients) send(c, entry);
  }

  function send(c: SseClient, entry: { event: EventEnvelope; seq: number }): void {
    if (c.missionId && entry.event.missionId !== c.missionId) return;
    if (c.types && !c.types.has(entry.event.type)) return;
    c.res.write(
      `id: ${encodeCursor(entry.seq)}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`,
    );
  }

  /** Runs scripted work strictly in order, `stepDelayMs` apart. */
  function later(fn: () => void): void {
    pending = pending.then(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            try {
              fn();
            } finally {
              resolve();
            }
          }, stepDelayMs),
        ),
    );
  }

  function need<T>(map: Map<string, T>, id: string, what: string): T {
    const v = map.get(id);
    if (!v) throw new MimirError("not_found", `${what} ${id} not found`);
    return v;
  }

  function stepsFor(title: string): TaskStep[] {
    const exact = scripts.get(title);
    if (exact) return [...exact];
    const prefix = title.split(":")[0] ?? title;
    return [...(scripts.get(prefix) ?? [])];
  }

  function transition(st: TaskState, type: EventType, to: Task["status"], extra: object = {}) {
    const from = st.task.status;
    st.task.status = to;
    touch(st.task);
    emit(
      type,
      { from, to, ...extra },
      {
        missionId: st.task.missionId,
        taskId: st.task.id,
        crewId: st.task.crewId,
        ...(st.sessionId ? { sessionId: st.sessionId } : {}),
      },
    );
  }

  /** Readies every pending task whose dependencies are complete, then runs it. */
  function pump(missionId: MissionId): void {
    const mission = missions.get(missionId);
    if (!mission || mission.status !== "active") return;
    const mine = [...tasks.values()].filter((t) => t.task.missionId === missionId);
    if (mine.length > 0 && mine.every((t) => t.task.status === "completed")) {
      const from = mission.status;
      mission.status = "completed";
      touch(mission);
      emit("mission.completed", { from, to: "completed" }, { missionId });
      return;
    }
    for (const st of mine) {
      if (st.task.status !== "pending") continue;
      const ready = st.dependsOn.every((d) => tasks.get(d)?.task.status === "completed");
      if (!ready) continue;
      transition(st, "task.ready", "ready");
      later(() => runAttempt(st));
    }
  }

  function runAttempt(st: TaskState): void {
    const agentId = newId("agt");
    const sessionId = newId("ses");
    st.agentId = agentId;
    st.task.attempt += 1;
    st.task.agentId = agentId;
    transition(st, "task.leased", "leased", {
      agentId,
      attempt: st.task.attempt,
      leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    st.sessionId = sessionId;
    sessions.set(sessionId, st.task.id);
    later(() => {
      transition(st, "task.started", "running", { agentId, sessionId });
      later(() => runStep(st));
    });
  }

  function runStep(st: TaskState): void {
    const step: TaskStep = st.steps.shift() ?? { kind: "complete" };
    const refs = {
      missionId: st.task.missionId,
      taskId: st.task.id,
      crewId: st.task.crewId,
      ...(st.sessionId ? { sessionId: st.sessionId } : {}),
    };
    if (step.kind === "fail") {
      transition(st, "task.failed", "failed", {
        reason: step.reason ?? "scripted failure",
        attempt: st.task.attempt,
        retryable: step.retryable ?? st.task.attempt < st.task.maxAttempts,
      });
      return;
    }
    if (step.kind === "approval") {
      const approval: Approval = {
        ...base(newId("apr")),
        action: step.action,
        status: "pending",
        actor: null,
        expiry: null,
        missionId: st.task.missionId,
        taskId: st.task.id,
        reason: step.reason ?? null,
      };
      approvals.set(approval.id, approval);
      emit(
        "approval.requested",
        {
          approvalId: approval.id,
          action: step.action,
          expiry: null,
          ...(step.reason ? { reason: step.reason } : {}),
        },
        refs,
      );
      st.task.blockedReason = "approval_required";
      transition(st, "task.blocked", "blocked", { reason: "approval_required" });
      return;
    }
    transition(st, "task.verifying", "verifying");
    later(() => {
      emit("test.run_completed", { command: "pnpm test", passed: true, total: 1, failed: 0 }, refs);
      for (const kind of step.artifacts ?? ["diff", "changed-files", "test.output"]) {
        const given = step.contents?.[kind];
        const content =
          (typeof given === "function" ? given(st.task.id) : given) ??
          (kind === "changed-files"
            ? JSON.stringify({
                worktreeId: `wt_${st.task.id}`,
                baseSha: createHash("sha1").update("base").digest("hex"),
                headSha: headShaOf(st.task.id),
                includesWorkingTree: false,
                dirty: false,
                files: [],
              })
            : `${kind} of ${st.task.id}`);
        const artifact: Artifact = {
          ...base(newId("art")),
          taskId: st.task.id,
          kind,
          uri: `file:///artifacts/${st.task.id}/${kind}`,
          hash: "sha256:" + createHash("sha256").update(content).digest("hex"),
        };
        artifacts.set(artifact.id, artifact);
        artifactBytes.set(artifact.id, content);
        emit(
          "artifact.recorded",
          {
            artifactId: artifact.id,
            taskId: st.task.id,
            kind,
            uri: artifact.uri,
            hash: artifact.hash,
          },
          refs,
        );
      }
      later(() => {
        transition(st, "task.completed", "completed");
        later(() => pump(st.task.missionId));
      });
    });
  }

  const accepted = () =>
    OperationAcceptedSchema.parse({ operationId: newId("op"), commandId: newId("cmd") });

  // -------------------------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------------------------

  type Handler = (ctx: {
    params: Record<string, string>;
    query: Record<string, string | string[]>;
    body: unknown;
  }) => Reply;

  type TaskRequest = Omit<z.infer<typeof CreateTaskRequestSchema>, "missionId">;
  /** Creates a task (the shared body of `POST /v1/tasks` and `POST /v1/missions { tasks }`). */
  function addTask(mission: Mission, req: TaskRequest): Task {
    let maxAttempts = 1;
    if (req.crewId) {
      const c = need(crews, req.crewId, "crew");
      if (c.crew.missionId !== mission.id) throw new MimirError("conflict", "crew not in mission");
      maxAttempts = c.crew.limits.maxAttemptsPerTask ?? 1;
    }
    for (const d of req.dependsOn ?? []) {
      const dep = need(tasks, d, "task");
      if (dep.task.missionId !== mission.id)
        throw new MimirError("conflict", "dependency in other mission");
    }
    const acceptance = (req.acceptanceCriteria ?? []).join("\n");
    const task: Task = {
      ...base(req.id ?? newId("tsk")),
      missionId: mission.id,
      crewId: req.crewId ?? null,
      title: req.title,
      acceptance,
      status: "pending",
      attempt: 0,
      maxAttempts,
      agentId: null,
      leaseExpiresAt: null,
    };
    tasks.set(task.id, {
      task,
      dependsOn: req.dependsOn ?? [],
      steps: stepsFor(task.title),
      sessionId: null,
      agentId: null,
    });
    creates.tasks += 1;
    emit(
      "task.created",
      {
        missionId: mission.id,
        crewId: task.crewId,
        title: task.title,
        acceptance: task.acceptance,
        dependsOn: req.dependsOn ?? [],
        brief: req.brief,
        ...(req.argv ? { argv: req.argv } : {}),
      },
      { missionId: mission.id, taskId: task.id, crewId: task.crewId },
    );
    return task;
  }

  const handlers: Record<string, Handler> = {
    "GET /v1/health": () => ({ status: 200, body: HealthResponseSchema.parse({ status: "ok" }) }),
    "GET /v1/capabilities": () => ({
      status: 200,
      body: CapabilitiesResponseSchema.parse({
        serverVersion: "fake-mimir",
        protocolVersion: 1,
        runtime: null,
      }),
    }),
    "GET /v1/snapshot": () => ({
      status: 200,
      body: SnapshotResponseSchema.parse({
        projects: [...projects.values()],
        missions: [...missions.values()],
        crews: [...crews.values()].map((c) => c.crew),
        tasks: [...tasks.values()].map((t) => t.task),
        taskDependencies: [],
        agents: [],
        approvals: [...approvals.values()],
        worktrees: [],
        usage: usageTotals(),
        cursor: encodeCursor(seq),
      }),
    }),
    "GET /v1/projects": () => ({
      status: 200,
      body: ListProjectsResponseSchema.parse({ projects: [...projects.values()] }),
    }),
    "POST /v1/projects": ({ body }) => {
      const req = parseWith(CreateProjectRequestSchema, body, "body");
      const project: Project = {
        ...base(newId("prj")),
        name: req.name,
        repoPath: req.repoPath,
        settings: req.settings ?? {},
      };
      projects.set(project.id, project);
      creates.projects += 1;
      return { status: 201, body: CreateProjectResponseSchema.parse({ project }) };
    },
    "GET /v1/missions": ({ query }) => {
      const q = parseWith(ListMissionsQuerySchema, query, "query");
      const list = [...missions.values()].filter(
        (m) =>
          (!q.projectId || m.projectId === q.projectId) && (!q.status || m.status === q.status),
      );
      return { status: 200, body: ListMissionsResponseSchema.parse({ missions: list }) };
    },
    "POST /v1/missions": ({ body }) => {
      const req = parseWith(CreateMissionRequestSchema, body, "body");
      need(projects, req.projectId, "project");
      const mission: Mission = {
        ...base(newId("msn")),
        projectId: req.projectId,
        objective: req.objective,
        status: "draft",
      };
      missions.set(mission.id, mission);
      creates.missions += 1;
      emit(
        "mission.created",
        { projectId: mission.projectId, objective: mission.objective },
        { missionId: mission.id },
      );
      const created = (req.tasks ?? []).map((t) => addTask(mission, t));
      return {
        status: 201,
        body: CreateMissionResponseSchema.parse({
          mission,
          ...(req.tasks ? { tasks: created } : {}),
        }),
      };
    },
    "GET /v1/missions/{id}": ({ params }) => {
      const { id } = parseWith(MissionIdParamsSchema, params, "path");
      const mission = need(missions, id, "mission");
      return {
        status: 200,
        body: GetMissionResponseSchema.parse({
          mission,
          crews: [...crews.values()].map((c) => c.crew).filter((c) => c.missionId === id),
          tasks: [...tasks.values()].map((t) => t.task).filter((t) => t.missionId === id),
        }),
      };
    },
    "POST /v1/missions/{id}/start": ({ params, body }) => {
      const { id } = parseWith(MissionIdParamsSchema, params, "path");
      parseWith(StartMissionRequestSchema, body, "body");
      const mission = need(missions, id, "mission");
      if (mission.status !== "draft" && mission.status !== "paused") {
        throw new MimirError("invalid_transition", `mission is ${mission.status}`);
      }
      const from = mission.status;
      mission.status = "active";
      touch(mission);
      emit("mission.started", { from, to: "active" }, { missionId: id });
      later(() => pump(id));
      return { status: 202, body: accepted() };
    },
    "POST /v1/missions/{id}/cancel": ({ params, body }) => {
      const { id } = parseWith(MissionIdParamsSchema, params, "path");
      const req = parseWith(CancelMissionRequestSchema, body, "body");
      const mission = need(missions, id, "mission");
      if (["completed", "cancelled", "failed"].includes(mission.status)) {
        throw new MimirError("invalid_transition", `mission is ${mission.status}`);
      }
      const from = mission.status;
      mission.status = "cancelled";
      touch(mission);
      emit(
        "mission.cancelled",
        { from, to: "cancelled", ...(req.reason ? { reason: req.reason } : {}) },
        { missionId: id },
      );
      return { status: 202, body: accepted() };
    },
    "GET /v1/crews": ({ query }) => {
      const q = parseWith(ListCrewsQuerySchema, query, "query");
      const list = [...crews.values()]
        .map((c) => c.crew)
        .filter((c) => !q.missionId || c.missionId === q.missionId);
      return { status: 200, body: ListCrewsResponseSchema.parse({ crews: list }) };
    },
    "POST /v1/crews": ({ body }) => {
      const req = parseWith(CreateCrewRequestSchema, body, "body");
      need(missions, req.missionId, "mission");
      const crew: Crew = {
        ...base(newId("crw")),
        missionId: req.missionId,
        template: req.template,
        status: "configured",
        limits: req.limits ?? {},
      };
      const members: CrewMember[] = req.members.map((m, i) => ({
        ...base(newId("cmb")),
        crewId: crew.id,
        role: m.role,
        agentKind: m.agentKind,
        name: m.name ?? `${m.role}-${i + 1}`,
      }));
      crews.set(crew.id, { crew, members });
      creates.crews += 1;
      return { status: 201, body: CreateCrewResponseSchema.parse({ crew, members }) };
    },
    "GET /v1/tasks": ({ query }) => {
      const q = parseWith(ListTasksQuerySchema, query, "query");
      const list = [...tasks.values()]
        .map((t) => t.task)
        .filter(
          (t) =>
            (!q.missionId || t.missionId === q.missionId) &&
            (!q.crewId || t.crewId === q.crewId) &&
            (!q.status || t.status === q.status),
        );
      return { status: 200, body: ListTasksResponseSchema.parse({ tasks: list }) };
    },
    "POST /v1/tasks": ({ body }) => {
      const req = parseWith(CreateTaskRequestSchema, body, "body");
      const mission = need(missions, req.missionId, "mission");
      if (mission.status !== "draft") {
        throw new MimirError("invalid_transition", "tasks can only be added to a draft mission");
      }
      const task = addTask(mission, req);
      return { status: 201, body: CreateTaskResponseSchema.parse({ task }) };
    },
    "POST /v1/tasks/{id}/retry": ({ params, body }) => {
      const { id } = parseWith(TaskIdParamsSchema, params, "path");
      const req = parseWith(RetryTaskRequestSchema, body, "body");
      const st = need(tasks, id, "task");
      if (st.task.status !== "failed" || st.task.attempt >= st.task.maxAttempts) {
        throw new MimirError(
          "invalid_transition",
          `task is ${st.task.status} (attempt ${st.task.attempt} of ${st.task.maxAttempts})`,
        );
      }
      st.task.status = "ready";
      touch(st.task);
      emit(
        "task.retried",
        {
          from: "failed",
          to: "ready",
          attempt: st.task.attempt + 1,
          ...(req.reason ? { reason: req.reason } : {}),
        },
        { missionId: st.task.missionId, taskId: st.task.id, crewId: st.task.crewId },
      );
      later(() => runAttempt(st));
      return { status: 202, body: accepted() };
    },
    "GET /v1/approvals": ({ query }) => {
      const q = parseWith(ListApprovalsQuerySchema, query, "query");
      const list = [...approvals.values()].filter(
        (a) =>
          (!q.status || a.status === q.status) && (!q.missionId || a.missionId === q.missionId),
      );
      return { status: 200, body: ListApprovalsResponseSchema.parse({ approvals: list }) };
    },
    "POST /v1/approvals/{id}/decision": ({ params, body }) => {
      const { id } = parseWith(ApprovalIdParamsSchema, params, "path");
      const req = parseWith(ApprovalDecisionRequestSchema, body, "body");
      const approval = need(approvals, id, "approval");
      if (approval.status !== "pending") {
        throw new MimirError("invalid_transition", `approval is ${approval.status}`);
      }
      approval.status = req.decision;
      approval.actor = "operator";
      touch(approval);
      const st = approval.taskId ? tasks.get(approval.taskId) : undefined;
      const missionId = approval.missionId as MissionId;
      const refs = { missionId, ...(st ? { taskId: st.task.id, crewId: st.task.crewId } : {}) };
      emit(
        "approval.decided",
        {
          approvalId: id,
          decision: req.decision,
          actor: "operator",
          ...(req.reason ? { reason: req.reason } : {}),
        },
        refs,
      );
      if (st && req.decision === "approved") {
        delete st.task.blockedReason;
        later(() => {
          transition(st, "task.started", "running", {
            agentId: st.agentId ?? newId("agt"),
            sessionId: st.sessionId ?? newId("ses"),
          });
          later(() => runStep(st));
        });
      } else if (st) {
        emit("policy.denied", { action: approval.action, reason: "approval rejected" }, refs);
      }
      return { status: 202, body: accepted() };
    },
    "POST /v1/sessions/{id}/input": ({ params, body }) => {
      const { id } = parseWith(SessionIdParamsSchema, params, "path");
      const req = parseWith(SendInstructionRequestSchema, body, "body");
      need(sessions, id, "session");
      sessionCommands.push({ sessionId: id, kind: "input", body: req });
      return { status: 202, body: accepted() };
    },
    "POST /v1/sessions/{id}/stop": ({ params, body }) => {
      const { id } = parseWith(SessionIdParamsSchema, params, "path");
      const req = parseWith(StopSessionRequestSchema, body, "body");
      need(sessions, id, "session");
      sessionCommands.push({ sessionId: id, kind: "stop", body: req });
      return { status: 202, body: accepted() };
    },
    "GET /v1/events": ({ query }) => {
      const q = parseWith(ListEventsQuerySchema, query, "query");
      const from = q.cursor ? decodeCursor(q.cursor) : 0;
      if (from > seq) throw new MimirError("cursor_expired", "cursor is unknown to this server");
      const matching = log.filter(
        (e) =>
          e.seq > from &&
          (!q.missionId || e.event.missionId === q.missionId) &&
          (!q.streamId || e.event.streamId === q.streamId) &&
          (!q.types || q.types.includes(e.event.type)),
      );
      const page = matching.slice(0, q.limit);
      const hasMore = matching.length > page.length;
      const last = page.at(-1);
      const lastCursor = last ? encodeCursor(last.seq) : (q.cursor ?? encodeCursor(seq));
      const body = {
        events: page.map((e) => e.event),
        nextCursor: hasMore && last ? encodeCursor(last.seq) : null,
      };
      ListEventsResponseSchema.parse(body);
      return { status: 200, body: { ...body, hasMore, lastCursor } };
    },
    "GET /v1/artifacts/{id}": ({ params }) => {
      const { id } = parseWith(ArtifactIdParamsSchema, params, "path");
      const artifact = need(artifacts, id, "artifact");
      return { status: 200, body: GetArtifactResponseSchema.parse({ artifact }) };
    },
    "GET /v1/artifacts/{id}/content": ({ params }) => {
      const { id } = parseWith(ArtifactIdParamsSchema, params, "path");
      const artifact = need(artifacts, id, "artifact");
      return {
        status: 200,
        body: artifactBytes.get(id) ?? "",
        raw: {
          "content-type": artifactContentType(artifact.kind),
          "x-artifact-hash": artifact.hash,
        },
      };
    },
    "GET /v1/usage": ({ query }) => {
      parseWith(UsageQuerySchema, query, "query");
      return {
        status: 200,
        body: UsageResponseSchema.parse({ totals: usageTotals(), samples: [] }),
      };
    },
  };

  function usageTotals() {
    return {
      tokens: 0,
      estimatedCost: 0,
      samples: 0,
      bySource: { measured: 0, estimated: 0, unavailable: 0 },
    };
  }

  function match(
    method: string,
    path: string,
  ): { key: string; params: Record<string, string> } | null {
    for (const route of ROUTES) {
      const [m, pattern] = route.split(" ") as [string, string];
      if (m !== method) continue;
      const a = pattern.split("/");
      const b = path.split("/");
      if (a.length !== b.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < a.length; i++) {
        const seg = a[i] as string;
        const val = decodeURIComponent(b[i] as string);
        if (seg === "{id}") params.id = val;
        else if (seg !== val) ok = false;
      }
      if (ok) return { key: route, params };
    }
    return null;
  }

  function handlerFor(key: string): Handler {
    const h = handlers[key];
    if (!h) throw new MimirError("not_found", `no handler for ${key}`);
    return h;
  }

  function sendJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  function sendReply(res: ServerResponse, reply: Reply, headers: Record<string, string> = {}) {
    if (reply.raw) {
      res.writeHead(reply.status, { ...reply.raw, ...headers });
      res.end(String(reply.body));
    } else sendJson(res, reply.status, reply.body, headers);
  }

  function sendError(res: ServerResponse, err: unknown) {
    const e =
      err instanceof MimirError
        ? err
        : new MimirError("internal", (err as Error)?.message ?? "error");
    sendJson(res, e.status, e.toBody());
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }

  function openStream(
    req: IncomingMessage,
    res: ServerResponse,
    query: Record<string, string | string[]>,
  ) {
    const header = req.headers["last-event-id"];
    const cursorRaw =
      (typeof header === "string" && header) || (query.cursor as string | undefined);
    let from: number | undefined;
    if (cursorRaw) {
      from = decodeCursor(cursorRaw);
      if (from > seq) throw new MimirError("cursor_expired", "cursor is unknown to this server");
    }
    const typesRaw = query.types;
    const types = typesRaw
      ? new Set((Array.isArray(typesRaw) ? typesRaw : typesRaw.split(",")).filter(Boolean))
      : undefined;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    const client: SseClient = {
      res,
      missionId: typeof query.missionId === "string" ? query.missionId : undefined,
      types,
      timer: setInterval(() => res.write(": heartbeat\n\n"), heartbeatMs),
    };
    if (from !== undefined) for (const e of log) if (e.seq > from) send(client, e);
    sseClients.add(client);
    res.on("close", () => {
      clearInterval(client.timer);
      sseClients.delete(client);
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = (req.method ?? "GET").toUpperCase();
    const raw = method === "POST" ? await readBody(req) : "";
    const key = req.headers[IDEMPOTENCY_HEADER];
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : method === "POST" ? {} : undefined;
    } catch {
      sendError(res, new MimirError("validation_failed", "body is not JSON", { issues: [] }));
      return;
    }
    requests.push({
      method,
      path: url.pathname,
      ...(typeof key === "string" ? { idempotencyKey: key } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    const failure = failures.findIndex(
      (f) => f.method === method && url.pathname.startsWith(f.prefix),
    );
    if (failure >= 0) {
      const [f] = failures.splice(failure, 1);
      sendJson(res, f!.status, { error: { code: "internal", message: "injected failure" } });
      return;
    }
    const m = match(method, url.pathname);
    if (!m) {
      sendError(res, new MimirError("not_found", `no route ${method} ${url.pathname}`));
      return;
    }
    if (m.key !== "GET /v1/health" && req.headers.authorization !== `Bearer ${token}`) {
      sendError(res, new MimirError("unauthorized", "missing or wrong bearer token"));
      return;
    }
    const query: Record<string, string | string[]> = {};
    for (const k of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(k);
      query[k] = all.length > 1 ? all : (all[0] as string);
    }
    try {
      if (m.key === "GET /v1/events/stream") {
        openStream(req, res, query);
        return;
      }
      if (method === "POST") {
        if (typeof key !== "string" || key.length === 0) {
          throw new MimirError("validation_failed", `missing ${IDEMPOTENCY_HEADER} header`, {
            issues: [],
          });
        }
        const hash = createHash("sha256").update(`${m.key} ${url.pathname} ${raw}`).digest("hex");
        const prior = idempotency.get(key);
        if (prior) {
          if (prior.hash !== hash) {
            throw new MimirError("idempotency_replay_mismatch", "key reused with another request");
          }
          sendReply(res, prior.reply, { "idempotency-replayed": "true" });
          return;
        }
        const reply = handlerFor(m.key)({ params: m.params, query, body });
        idempotency.set(key, { hash, reply });
        sendReply(res, reply);
        return;
      }
      const reply = handlerFor(m.key)({ params: m.params, query, body });
      sendReply(res, reply);
    } catch (err) {
      sendError(res, err);
    }
  }

  let server: Server | undefined;
  const listen = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const srv = createServer((req, res) => void handle(req, res));
      server = srv;
      srv.on("connection", (s) => {
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve((srv.address() as AddressInfo).port));
    });
  const port = await listen(0);
  const url = `http://127.0.0.1:${port}`;

  function dropSseClients(): void {
    for (const c of sseClients) {
      clearInterval(c.timer);
      c.res.end();
    }
    sseClients.clear();
  }

  async function stop(): Promise<void> {
    dropSseClients();
    const srv = server;
    if (!srv) return;
    server = undefined;
    const closed = new Promise<void>((resolve) => srv.close(() => resolve()));
    for (const s of sockets) s.destroy();
    await closed;
  }

  return {
    url,
    token,
    routes: ROUTES,
    creates,
    requests,
    sessionCommands,
    script(titleOrPrefix, steps) {
      scripts.set(titleOrPrefix, steps);
    },
    inject(type, payload, refs) {
      emit(type, payload, refs);
    },
    failNext(method, pathPrefix, status = 500) {
      failures.push({ method: method.toUpperCase(), prefix: pathPrefix, status });
    },
    events: () => log.map((e) => e.event),
    cursorAt: (n) => encodeCursor(n),
    latestCursor: () => encodeCursor(seq),
    tasks: () => [...tasks.values()].map((t) => t.task),
    approvals: () => [...approvals.values()],
    artifacts: () => [...artifacts.values()],
    headShaOf,
    tamper: (id, content) => {
      need(artifacts, id, "artifact");
      artifactBytes.set(id, content);
    },
    async waitForSseClients(n) {
      const deadline = Date.now() + 5000;
      while (sseClients.size < n) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${n} SSE clients`);
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    dropSseClients,
    stop,
    async start() {
      await listen(port);
    },
    async close() {
      await pending.catch(() => undefined);
      await stop().catch(() => undefined);
    },
  };
}
