import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { createMimirClient, type GapInfo, type MimirClient } from "@mimir/sdk";
import {
  parseEvent,
  CreateTaskRequestSchema,
  type ApprovalDecision,
  type ApprovalId,
  type Artifact,
  type ArtifactId,
  type CapabilitiesResponse,
  type CreateTaskRequest,
  type CrewId,
  type EventEnvelope,
  type GetMissionResponse,
  type MimirEvent,
  type MissionId,
  type Project,
  type ProjectId,
  type SessionId,
  type Task,
  type TaskId,
  type UsageResponse,
} from "@mimir/protocol";
import { applyMigrations, type SqliteDatabase } from "@sindri/knowledge";
import type { Plan, Role } from "@sindri/planner";
import { mapPlan, type AgentKindResolver, type MappedPlan } from "./mapping.js";
import { MIMIR_CLIENT_MIGRATIONS } from "./migrations.js";

export type MimirClientErrorCode =
  "not_connected" | "invalid_plan" | "submission_mismatch" | "not_supported" | "hash_mismatch";

export class MimirClientError extends Error {
  override readonly name = "MimirClientError";
  constructor(
    readonly code: MimirClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface MimirClientFacadeOptions {
  db: SqliteDatabase;
  acceptanceCriteriaFor?: (plan: Plan) => { id: string; text: string }[];
  /** Mimir `agentKind` per (harness, role). Default `claude` for everything. */
  agentKindFor?: AgentKindResolver;
  /** Per-role crew concurrency, merged over the planner's `DEFAULT_CONCURRENCY`. */
  concurrency?: Partial<Record<Role, number>>;
  /** Injected `fetch` (tests). */
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface ConnectConfig {
  baseUrl: string;
  token: string;
}

/** `CreateTaskRequest` with plain-string ids (Sindri stores Mimir ids unbranded). */
export type CreateTaskInput = Omit<CreateTaskRequest, "missionId" | "crewId" | "dependsOn"> & {
  missionId: string;
  crewId?: string;
  dependsOn?: string[];
};

export interface MissionSubmission {
  missionId: MissionId;
  /** Sindri plan task id -> Mimir task id. */
  taskIdMap: Record<string, TaskId>;
  /** `<harnessId>:<role>` -> Mimir crew id. */
  crewIds: Record<string, CrewId>;
  /** Plan budgets Mimir cannot enforce (wall-clock minutes); Sindri records them. */
  unforwardedBudgets: MappedPlan["unforwardedBudgets"];
}

export interface FollowOptions {
  /** Resume after this cursor; default the stored cursor for the mission. */
  fromCursor?: string;
  signal?: AbortSignal;
  onGap?: (info: GapInfo) => void;
  /** Called for an event that fails protocol validation; the event is skipped. */
  onInvalidEvent?: (envelope: EventEnvelope, error: unknown) => void;
}

/** Typed mission events. Iterate once; `cursor` is the position after the latest yielded event. */
export interface FollowStream extends AsyncIterable<MimirEvent> {
  readonly cursor: string | undefined;
}

/**
 * Sindri's only door into Mimir. Wraps `@mimir/sdk` with plan-to-mission mapping, idempotency
 * keys derived from the plan (`sindri:<planId>:<version>:<taskId>`), a local record of every
 * completed submission, and cursor persistence for event following.
 */
export class MimirClientFacade {
  private client: MimirClient | undefined;
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;

  constructor(private readonly options: MimirClientFacadeOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => new Date());
    applyMigrations(this.db, "mimir_client", MIMIR_CLIENT_MIGRATIONS);
  }

  connect(config: ConnectConfig): this {
    const f = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    this.client = createMimirClient({
      baseUrl: config.baseUrl,
      token: config.token,
      fetch: (input, init) => f(input, init),
    });
    return this;
  }

  /** The underlying SDK client (for reads the facade does not wrap). */
  get sdk(): MimirClient {
    if (!this.client) throw new MimirClientError("not_connected", "call connect() first");
    return this.client;
  }

  async capabilities(): Promise<CapabilitiesResponse> {
    return this.sdk.capabilities();
  }

  /** The Mimir project for `repoPath`, created once (idempotently) when missing. */
  async ensureProject(repoPath: string, settings: Record<string, unknown> = {}): Promise<Project> {
    // Mimir records canonical git roots; macOS temp paths commonly contain symlinks.
    try {
      repoPath = realpathSync(repoPath);
    } catch {
      /* A remote Mimir may own the path. */
    }
    const { projects } = await this.sdk.projects.list();
    const existing = projects.find((p) => p.repoPath === repoPath);
    if (existing) return existing;
    const key = `sindri:project:${createHash("sha256").update(repoPath).digest("hex").slice(0, 32)}`;
    const { project } = await this.submit("project", key, async () => {
      const res = await this.sdk.projects.create(
        { name: basename(repoPath) || repoPath, repoPath, settings },
        { idempotencyKey: key },
      );
      return { id: res.project.id, value: res };
    });
    return project;
  }

  /**
   * Creates the mission, one crew per distinct (harnessId, role) and one task per plan task, in
   * dependency order. Every mutation uses a key derived from the plan, and completed ones are
   * recorded locally, so re-running after a crash creates nothing new.
   */
  async createMissionFromPlan(
    plan: Plan,
    { projectId, run }: { projectId: ProjectId | string; run?: number },
  ): Promise<MissionSubmission> {
    let mapped;
    try {
      mapped = mapPlan(plan, {
        ...(this.options.acceptanceCriteriaFor
          ? { acceptanceCriteria: this.options.acceptanceCriteriaFor(plan) }
          : {}),
        ...(this.options.agentKindFor ? { agentKindFor: this.options.agentKindFor } : {}),
        ...(this.options.concurrency ? { concurrency: this.options.concurrency } : {}),
        ...(run !== undefined ? { run } : {}),
      });
    } catch (err) {
      throw new MimirClientError("invalid_plan", (err as Error).message);
    }
    const client = this.sdk;
    const fresh = !this.recorded(mapped.missionIdempotencyKey);
    // Position before the mission exists, so following it later starts with mission.created.
    const head = fresh ? (await client.snapshot()).cursor : undefined;
    const { mission } = await this.submit("mission", mapped.missionIdempotencyKey, async () => {
      const res = await client.missions.create(
        { projectId: projectId as ProjectId, objective: mapped.objective },
        { idempotencyKey: mapped.missionIdempotencyKey },
      );
      return { id: res.mission.id, value: res };
    });
    if (head && this.storedCursor(mission.id) === null) {
      // Only trust `head` when the mission was really created after it. If Mimir replayed an
      // older mission (local record lost), leave the cursor unset so `follow` replays history.
      const after = await client.events.list({
        cursor: head,
        missionId: mission.id,
        types: ["mission.created"],
        limit: 1,
      });
      if (after.events.length > 0) this.saveCursor(mission.id, head);
    }

    const crewIds: Record<string, CrewId> = {};
    for (const crew of mapped.crews) {
      const res = await this.submit("crew", crew.idempotencyKey, async () => {
        const r = await client.crews.create(
          { missionId: mission.id, ...crew.request },
          { idempotencyKey: crew.idempotencyKey },
        );
        return { id: r.crew.id, value: r };
      });
      crewIds[crew.key] = res.crew.id;
    }

    const taskIdMap: Record<string, TaskId> = {};
    for (const task of mapped.tasks) {
      const crewId = crewIds[task.crewKey];
      const res = await this.submit("task", task.idempotencyKey, async () => {
        const r = await client.tasks.create(
          {
            missionId: mission.id,
            ...(crewId ? { crewId } : {}),
            ...(plan.tasks.find((t) => t.id === task.planTaskId)?.harnessSelection?.lock
              .lockVersion === 2
              ? {
                  verification: {
                    harnesses: plan.tasks
                      .find((t) => t.id === task.planTaskId)!
                      .harnessSelection!.harnesses.map((h) => `${h.name}@${h.version}`),
                    lock: plan.tasks.find((t) => t.id === task.planTaskId)!.harnessSelection!.lock,
                  },
                }
              : {}),
            title: task.title,
            ...(task.priority !== undefined ? { priority: task.priority } : {}),
            brief: task.brief,
            timeoutMs: task.timeoutMs,
            ...(task.acceptanceCriteria.length > 0
              ? { acceptanceCriteria: task.acceptanceCriteria }
              : {}),
            dependsOn: task.dependsOn.map((d) => taskIdMap[d] as TaskId),
          },
          { idempotencyKey: task.idempotencyKey },
        );
        return { id: r.task.id, value: r };
      });
      taskIdMap[task.planTaskId] = res.task.id;
    }
    return {
      missionId: mission.id,
      taskIdMap,
      crewIds,
      unforwardedBudgets: mapped.unforwardedBudgets,
    };
  }

  async start(missionId: MissionId | string): Promise<void> {
    await this.sdk.missions.start(
      missionId as MissionId,
      {},
      {
        idempotencyKey: `sindri:start:${missionId}`,
      },
    );
  }

  async cancel(missionId: MissionId | string, reason?: string): Promise<void> {
    await this.sdk.missions.cancel(missionId as MissionId, reason ? { reason } : {}, {
      idempotencyKey: `sindri:cancel:${missionId}`,
    });
  }

  async approvalForMission(missionId: string, approvalId: string) {
    const { approvals } = await this.sdk.approvals.list({ missionId: missionId as MissionId });
    return approvals.find((a) => a.id === approvalId && a.missionId === missionId);
  }

  async getMission(missionId: MissionId | string): Promise<GetMissionResponse> {
    return this.sdk.missions.get(missionId as MissionId);
  }

  /**
   * Follows a mission's events from `fromCursor`, else the stored cursor. The stored cursor
   * advances when the consumer asks for the next event (at-least-once delivery); call
   * `saveCursor(missionId, stream.cursor)` inside your own transaction for exactly-once
   * bookkeeping. Without any cursor it replays the mission's history first.
   */
  follow(missionId: MissionId | string, options: FollowOptions = {}): FollowStream {
    const client = this.sdk;
    let cursor: string | undefined =
      options.fromCursor ?? this.storedCursor(missionId) ?? undefined;
    const seen = new Set<string>();
    const persist = (c: string | undefined) => {
      if (c) this.saveCursor(missionId, c);
    };
    const parse = (env: EventEnvelope): MimirEvent | undefined => {
      try {
        return parseEvent(env);
      } catch (err) {
        options.onInvalidEvent?.(env, err);
        return undefined;
      }
    };
    const signal = options.signal;
    async function* run(): AsyncGenerator<MimirEvent> {
      if (!cursor) {
        const replay = await client.events.replayAll({
          missionId: missionId as MissionId,
          ...(signal ? { signal } : {}),
        });
        for (const env of replay.events) {
          seen.add(env.id);
          const ev = parse(env);
          if (ev) yield ev;
        }
        if (replay.cursor) {
          cursor = replay.cursor;
          persist(cursor);
        }
      }
      const stream = client.events.stream({
        missionId: missionId as MissionId,
        ...(cursor ? { cursor } : {}),
        ...(signal ? { signal } : {}),
        ...(options.onGap ? { onGap: options.onGap } : {}),
      });
      for await (const env of stream) {
        const at = stream.cursor;
        if (!seen.has(env.id)) {
          seen.add(env.id);
          const ev = parse(env);
          if (at) cursor = at;
          if (ev) yield ev;
        } else if (at) {
          cursor = at;
        }
        persist(at);
      }
    }
    const iterable = run();
    return {
      [Symbol.asyncIterator]: () => iterable,
      get cursor() {
        return cursor;
      },
    };
  }

  /**
   * Every event of the mission after the stored cursor (or from the start), read by paging
   * `GET /v1/events` to the end, plus the caught-up cursor. Does not move the stored cursor.
   */
  async catchUp(
    missionId: MissionId | string,
    options: { onInvalidEvent?: FollowOptions["onInvalidEvent"]; signal?: AbortSignal } = {},
  ): Promise<{ events: MimirEvent[]; cursor: string | null }> {
    const from = this.storedCursor(missionId);
    const replay = await this.sdk.events.replayAll({
      missionId: missionId as MissionId,
      ...(from ? { from } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const events: MimirEvent[] = [];
    for (const env of replay.events) {
      try {
        events.push(parseEvent(env));
      } catch (err) {
        options.onInvalidEvent?.(env, err);
      }
    }
    return { events, cursor: replay.cursor ?? from };
  }

  storedCursor(missionId: MissionId | string): string | null {
    const row = this.db
      .prepare("SELECT cursor FROM execution_cursors WHERE mission_id = ?")
      .get(missionId) as { cursor: string } | undefined;
    return row?.cursor ?? null;
  }

  saveCursor(missionId: MissionId | string, cursor: string): void {
    this.db
      .prepare(
        `INSERT INTO execution_cursors (mission_id, cursor, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(mission_id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(missionId, cursor, this.now().toISOString());
  }

  /** Records a human decision. Sindri never calls this on its own initiative to approve. */
  async decideApproval(
    approvalId: ApprovalId | string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    await this.sdk.approvals.decide(
      approvalId as ApprovalId,
      { decision, ...(reason ? { reason } : {}) },
      { idempotencyKey: `sindri:approval:${approvalId}` },
    );
  }

  async sendInstruction(
    sessionId: SessionId | string,
    text: string,
    options: { idempotencyKey?: string } = {},
  ): Promise<void> {
    await this.sdk.sessions.input(
      sessionId as SessionId,
      { text },
      options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {},
    );
  }

  async stop(sessionId: SessionId | string, mode: "soft" | "force" = "soft"): Promise<void> {
    await this.sdk.sessions.stop(sessionId as SessionId, { mode });
  }

  /** Retries a failed task. With `attempt`, the key `sindri:retry:<taskId>:<attempt>` makes it idempotent. */
  async retry(
    taskId: TaskId | string,
    options: { attempt?: number; reason?: string } = {},
  ): Promise<void> {
    await this.sdk.tasks.retry(
      taskId as TaskId,
      options.reason ? { reason: options.reason } : {},
      options.attempt !== undefined
        ? { idempotencyKey: `sindri:retry:${taskId}:${options.attempt}` }
        : {},
    );
  }

  async getArtifact(artifactId: ArtifactId | string): Promise<Artifact> {
    return (await this.sdk.artifacts.get(artifactId as ArtifactId)).artifact;
  }

  /** Every envelope of the mission (with `source`, `provenance`, `taskId`, `sessionId`). */
  async replayEnvelopes(missionId: MissionId | string): Promise<EventEnvelope[]> {
    return (await this.sdk.events.replayAll({ missionId: missionId as MissionId })).events;
  }

  /** Adds a one-member crew to a mission (quality/delivery: reviewer or QA crews). */
  async createCrew(
    input: { missionId: MissionId | string; role: "reviewer" | "qa"; agentKind: string },
    idempotencyKey: string,
  ): Promise<{ crewId: CrewId }> {
    const res = await this.sdk.crews.create(
      {
        missionId: input.missionId as MissionId,
        template: input.role,
        members: [{ role: input.role, agentKind: input.agentKind, name: `sindri-${input.role}` }],
      },
      { idempotencyKey },
    );
    return { crewId: res.crew.id };
  }

  /** Adds a task to a (non-terminal) mission: `client.tasks.create` (`POST /v1/tasks`). */
  async createTask(body: CreateTaskInput, idempotencyKey: string): Promise<Task> {
    return (await this.sdk.tasks.create(CreateTaskRequestSchema.parse(body), { idempotencyKey }))
      .task;
  }

  /**
   * Artifact text from Mimir (`GET /v1/artifacts/:id/content`) via the SDK's
   * `artifacts.content(id)`, which returns `{ bytes, contentType, hash }`. When the served
   * `x-artifact-hash` is a SHA-256 the bytes must match it. Sindri never reads Mimir's filesystem.
   */
  async artifactContent(artifactId: ArtifactId | string): Promise<string> {
    const { bytes, hash } = await this.sdk.artifacts.content(artifactId as ArtifactId);
    const claimed = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(hash.trim());
    if (claimed && claimed[1]!.toLowerCase() !== createHash("sha256").update(bytes).digest("hex")) {
      throw new MimirClientError(
        "hash_mismatch",
        `artifact ${artifactId} bytes do not match the hash Mimir served`,
      );
    }
    return new TextDecoder().decode(bytes);
  }

  /** Request a PR through the published SDK; Mimir retains the approval gate. */
  async requestPr(
    taskId: TaskId | string,
    idempotencyKey: string,
  ): Promise<{ status: "requested" | "awaiting_approval"; approvalId?: string }> {
    const result = await this.sdk.tasks.requestPr(taskId as TaskId, { idempotencyKey });
    if (result.status === "approval_required") {
      const consumed = await this.sdk.events.list({
        streamId: `approval:${result.approvalId}`,
        types: ["approval.consumed"],
      });
      if (
        consumed.events.some(
          (e) => (e.payload as { approvalId?: string }).approvalId === result.approvalId,
        )
      )
        return { status: "requested" };
    }
    return result.status === "approval_required"
      ? { status: "awaiting_approval", approvalId: result.approvalId }
      : { status: "requested" };
  }

  async getUsage(missionId: MissionId | string): Promise<UsageResponse> {
    return this.sdk.usage.get({ missionId: missionId as MissionId });
  }

  private recorded(key: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM mimir_submissions WHERE idempotency_key = ?").get(key) !==
      undefined
    );
  }

  /** Runs `call` once per idempotency key; later runs return the recorded response. */
  private async submit<T>(
    kind: string,
    key: string,
    call: () => Promise<{ id: string; value: T }>,
  ): Promise<T> {
    const row = this.db
      .prepare("SELECT kind, response_json FROM mimir_submissions WHERE idempotency_key = ?")
      .get(key) as { kind: string; response_json: string } | undefined;
    if (row) {
      if (row.kind !== kind) {
        throw new MimirClientError("submission_mismatch", `key ${key} was used for a ${row.kind}`);
      }
      return JSON.parse(row.response_json) as T;
    }
    const { id, value } = await call();
    this.db
      .prepare(
        `INSERT INTO mimir_submissions (idempotency_key, kind, mimir_id, response_json, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(key, kind, id, JSON.stringify(value), this.now().toISOString());
    return value;
  }
}
