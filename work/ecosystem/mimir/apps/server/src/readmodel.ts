import { createHash } from "node:crypto";
import type { EventStore } from "@mimir/core";
import {
  payloadSchemaFor,
  type Agent,
  type Approval,
  type Artifact,
  type BudgetPolicy,
  type Crew,
  type CrewMember,
  type CrewRole,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
  type Mission,
  type Project,
  type RuntimeRef,
  type RuntimeSessionState,
  type SnapshotResponse,
  type Task,
  type TaskDependency,
  type UsageSample,
  type UsageTotals,
  type Worktree,
} from "@mimir/protocol";
import { continueCursorOf } from "./paging.js";

/** Runtime session as projected from `session.*` events (not part of `SnapshotResponse`). */
export interface SessionView {
  id: string;
  crewId: string | null;
  taskId: string | null;
  agentKind: string | null;
  runtime: string | null;
  runtimeRef: RuntimeRef;
  state: RuntimeSessionState;
  runtimeStatus: string | null;
  exitCode: number | null;
  lostReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReadModelOptions {
  /** Initial cursor (defaults to the empty-store cursor). */
  cursor?: string;
  /** Called for events that could not be applied (bad payload, unknown target entity). */
  onSkip?: (event: EventEnvelope, reason: string) => void;
}

export interface LoadOptions extends Omit<ReadModelOptions, "cursor"> {
  /** Page size used while folding the store on boot. */
  pageSize?: number;
}

/** Who requested an approval and what it covers (not part of the protocol `Approval`). */
export interface ApprovalMeta {
  requestedBy: { kind: "agent" | "human" | "system"; id: string } | null;
  payloadSummary: string;
  sessionId: string | null;
  /** The action instance the approval covers (`approval.requested.subject`). */
  subject: string | null;
  /** Set by `approval.consumed`: an approved approval is used once. */
  consumed: boolean;
}

const EMPTY_CURSOR = Buffer.from("0", "utf8").toString("base64");
const DEFAULT_ROLE: CrewRole = "implementer";
const DEFAULT_MAX_ATTEMPTS = 3;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID-shaped id derived from `seed`, so rebuilding the model yields the same ids. */
export function deterministicId<P extends string>(prefix: P, seed: string): `${P}_${string}` {
  const bytes = createHash("sha256").update(seed).digest();
  let bits = "";
  for (const b of bytes.subarray(0, 17)) bits += b.toString(2).padStart(8, "0");
  // 26 chars: first carries 3 bits (ULID's first char is 0-7), the rest 5 bits each.
  let out = CROCKFORD[parseInt(bits.slice(0, 3), 2)] as string;
  for (let i = 0; i < 25; i++) {
    out += CROCKFORD[parseInt(bits.slice(3 + i * 5, 8 + i * 5), 2)] as string;
  }
  return `${prefix}_${out}`;
}

const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1;

type Versioned = { updatedAt: string; version: number };

function bump<T extends Versioned>(entity: T, at: string, patch: Partial<T>): T {
  return { ...entity, ...patch, updatedAt: at, version: entity.version + 1 };
}

class Skip extends Error {}

/**
 * In-memory projection of the event log: missions, tasks (+ dependencies), crews, agents,
 * sessions, approvals, worktrees and usage. Built by folding events; `GET /v1/snapshot` reads it.
 * Projects, crews and usage are folded from `project.created`, `crew.created` and `usage.recorded`.
 */
export class ReadModel {
  readonly projects = new Map<string, Project>();
  readonly missions = new Map<string, Mission>();
  readonly crews = new Map<string, Crew>();
  readonly crewMembers = new Map<string, CrewMember>();
  readonly tasks = new Map<string, Task>();
  readonly taskDependencies = new Map<string, TaskDependency>();
  readonly agents = new Map<string, Agent>();
  readonly sessions = new Map<string, SessionView>();
  readonly approvals = new Map<string, Approval>();
  readonly worktrees = new Map<string, Worktree>();
  /** `git.worktree_created.baseRef`, passed to `GitManager.restore` after a restart. */
  readonly worktreeBaseRefs = new Map<string, string>();
  readonly usageSamples = new Map<string, UsageSample>();
  /** Budgets from `mission.created` / `crew.created`. */
  readonly budgets = new Map<string, BudgetPolicy>();
  readonly artifacts = new Map<string, Artifact>();
  readonly artifactBytes = new Map<string, number>();
  readonly approvalMeta = new Map<string, ApprovalMeta>();
  /** `task.created` brief/argv per task (what the dispatched session runs). */
  private readonly taskSpecs = new Map<string, { brief?: string; argv?: string[] }>();
  /** Cursor of the last applied event; consistent with `snapshot()`. */
  cursor: string;
  /** `occurredAt` of the last applied event. */
  lastEventAt: string | null = null;

  private readonly onSkip: (event: EventEnvelope, reason: string) => void;
  private unsubscribe: (() => void) | null = null;

  constructor(options: ReadModelOptions = {}) {
    this.cursor = options.cursor ?? EMPTY_CURSOR;
    this.onSkip = options.onSkip ?? (() => undefined);
  }

  /** Folds every stored event, then keeps the model current via `store.subscribe`. */
  static load(store: EventStore, options: LoadOptions = {}): ReadModel {
    const { pageSize = 500, ...rest } = options;
    const model = new ReadModel(rest);
    // better-sqlite3 is synchronous: no append can interleave between this fold and subscribe.
    // Start at the oldest retained event: a cursor-less read fails once the log was pruned.
    let cursor = store.earliestCursor() ?? store.latestCursor();
    for (;;) {
      const page = store.read({ cursor, limit: pageSize });
      for (const event of page.events) model.apply(event);
      const next = continueCursorOf(page);
      if (next === null) break;
      cursor = next;
    }
    model.cursor = store.latestCursor();
    model.unsubscribe = store.subscribe((event, eventCursor) => model.apply(event, eventCursor));
    return model;
  }

  /** Stops following the store. */
  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The brief and explicit argv a task was created with (both optional). */
  taskSpec(taskId: string): { brief?: string; argv?: string[] } {
    return this.taskSpecs.get(taskId) ?? {};
  }

  /** Applies one event. Never throws; returns false when the event was skipped. */
  apply(event: EventEnvelope, cursor?: string): boolean {
    if (cursor !== undefined) this.cursor = cursor;
    this.lastEventAt = event.occurredAt;
    try {
      const parsed = payloadSchemaFor(event.type).safeParse(event.payload);
      if (!parsed.success) throw new Skip("invalid payload");
      this.applyTyped(event, event.type, parsed.data as never);
      return true;
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      this.onSkip(event, e.message);
      return false;
    }
  }

  snapshot(): SnapshotResponse {
    const sorted = <T extends { createdAt: string; id: string }>(m: Map<string, T>) =>
      [...m.values()].sort(byCreated);
    return {
      projects: sorted(this.projects),
      missions: sorted(this.missions),
      crews: sorted(this.crews),
      tasks: sorted(this.tasks),
      taskDependencies: sorted(this.taskDependencies),
      agents: sorted(this.agents),
      approvals: sorted(this.approvals),
      worktrees: sorted(this.worktrees),
      usage: this.usageTotals(),
      cursor: this.cursor,
    };
  }

  usageTotals(): UsageTotals {
    const totals: UsageTotals = {
      tokens: 0,
      estimatedCost: 0,
      samples: 0,
      bySource: { measured: 0, estimated: 0, unavailable: 0 },
    };
    for (const s of this.usageSamples.values()) {
      totals.samples += 1;
      totals.bySource[s.source] += 1;
      totals.tokens += s.tokens ?? 0;
      totals.estimatedCost += s.estimatedCost ?? 0;
    }
    return totals;
  }

  // -------------------------------------------------------------------------

  private applyTyped<T extends EventType>(
    event: EventEnvelope,
    type: T,
    payload: EventPayloadMap[T],
  ): void {
    const at = event.occurredAt;
    // Narrowing a generic payload by `type` needs a cast per branch; keep them local.
    const p = payload as EventPayloadMap[EventType] & Record<string, unknown>;
    switch (type) {
      case "project.created": {
        const pl = p as EventPayloadMap["project.created"];
        this.projects.set(pl.project.id, pl.project as Project);
        return;
      }
      case "crew.scheduling_changed": {
        const pl = p as EventPayloadMap["crew.scheduling_changed"];
        const crew = this.crews.get(pl.crewId);
        if (crew)
          this.crews.set(crew.id, {
            ...crew,
            schedulingPaused: pl.paused,
            updatedAt: at,
            version: crew.version + 1,
          });
        return;
      }
      case "crew.created": {
        const pl = p as EventPayloadMap["crew.created"];
        this.crews.set(pl.crew.id, pl.crew as Crew);
        for (const m of pl.members) this.crewMembers.set(m.id, m as CrewMember);
        if (pl.budget) this.budgets.set(pl.budget.id, pl.budget as BudgetPolicy);
        return;
      }
      case "usage.recorded": {
        const pl = p as EventPayloadMap["usage.recorded"];
        this.usageSamples.set(pl.sample.id, pl.sample as UsageSample);
        return;
      }
      case "artifact.recorded": {
        const pl = p as EventPayloadMap["artifact.recorded"];
        this.artifacts.set(pl.artifactId, {
          id: pl.artifactId,
          taskId: pl.taskId,
          kind: pl.kind,
          uri: pl.uri,
          hash: pl.hash,
          createdAt: at,
          updatedAt: at,
          version: 0,
        });
        if (pl.bytes !== undefined) this.artifactBytes.set(pl.artifactId, pl.bytes);
        return;
      }
      case "mission.created": {
        const id = this.need(event.missionId);
        const pl = p as EventPayloadMap["mission.created"];
        if (pl.budget) this.budgets.set(pl.budget.id, pl.budget as BudgetPolicy);
        this.missions.set(id, {
          id: id as Mission["id"],
          projectId: pl.projectId,
          objective: pl.objective,
          status: "draft",
          createdAt: at,
          updatedAt: at,
          version: 0,
        });
        return;
      }
      case "mission.started":
      case "mission.paused":
      case "mission.resumed":
      case "mission.cancelled":
      case "mission.completed":
      case "mission.failed": {
        const id = this.need(event.missionId);
        const m = this.existing(this.missions, id);
        const pl = p as EventPayloadMap["mission.started"] | EventPayloadMap["mission.paused"];
        this.missions.set(id, bump(m, at, { status: pl.to }));
        return;
      }
      case "task.created": {
        const id = this.need(event.taskId);
        const pl = p as EventPayloadMap["task.created"];
        const crew = pl.crewId === null ? undefined : this.crews.get(pl.crewId);
        this.taskSpecs.set(id, {
          ...(pl.brief !== undefined ? { brief: pl.brief } : {}),
          ...(pl.argv !== undefined ? { argv: pl.argv } : {}),
        });
        this.tasks.set(id, {
          id: id as Task["id"],
          missionId: pl.missionId,
          crewId: pl.crewId,
          title: pl.title,
          ...(pl.priority !== undefined ? { priority: pl.priority } : {}),
          ...(pl.verification !== undefined ? { verification: pl.verification } : {}),
          ...(pl.timeoutMs !== undefined ? { timeoutMs: pl.timeoutMs } : {}),
          acceptance: pl.acceptance,
          status: "pending",
          attempt: 0,
          maxAttempts: crew?.limits.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS,
          agentId: null,
          leaseExpiresAt: null,
          createdAt: at,
          updatedAt: at,
          version: 0,
        });
        pl.dependsOn.forEach((dependsOnId) => {
          const depId = deterministicId("tdp", `${event.id}:${dependsOnId}`);
          this.taskDependencies.set(depId, {
            id: depId as TaskDependency["id"],
            taskId: id as Task["id"],
            dependsOnId,
            createdAt: at,
            updatedAt: at,
            version: 0,
          });
        });
        return;
      }
      case "task.ready":
      case "task.blocked":
      case "task.verifying":
      case "task.completed":
      case "task.cancelled":
      case "task.leased":
      case "task.started":
      case "task.failed":
      case "task.retried": {
        this.applyTask(event, type, p);
        return;
      }
      case "session.requested": {
        const id = this.need(event.sessionId);
        const pl = p as EventPayloadMap["session.requested"];
        this.sessions.set(id, {
          id,
          crewId: pl.crewId,
          taskId: pl.taskId,
          agentKind: pl.agentKind,
          runtime: null,
          runtimeRef: {},
          state: "requested",
          runtimeStatus: null,
          exitCode: null,
          lostReason: null,
          createdAt: at,
          updatedAt: at,
        });
        return;
      }
      case "session.started": {
        const pl = p as EventPayloadMap["session.started"];
        const current = this.sessions.get(this.need(event.sessionId));
        this.updateSession(event, {
          runtime: pl.runtime,
          runtimeRef: pl.runtimeRef,
          // states observed while createSession was still running are newer than "starting"
          ...(current?.state === "requested" ? { state: "starting" as const } : {}),
        });
        return;
      }
      case "session.state_changed": {
        const pl = p as EventPayloadMap["session.state_changed"];
        this.updateSession(event, { state: pl.to, runtimeStatus: pl.runtimeStatus ?? null });
        return;
      }
      case "session.exited": {
        const pl = p as EventPayloadMap["session.exited"];
        this.updateSession(event, { exitCode: pl.exitCode ?? null });
        return;
      }
      case "session.lost": {
        const pl = p as EventPayloadMap["session.lost"];
        this.updateSession(event, { state: "unknown", lostReason: pl.reason });
        return;
      }
      case "approval.requested": {
        const pl = p as EventPayloadMap["approval.requested"];
        this.approvalMeta.set(pl.approvalId, {
          requestedBy: pl.requestedBy ?? null,
          payloadSummary: pl.reason ?? pl.action,
          sessionId: event.sessionId ?? null,
          subject: pl.subject ?? null,
          consumed: false,
        });
        this.approvals.set(pl.approvalId, {
          id: pl.approvalId,
          action: pl.action,
          status: "pending",
          actor: null,
          expiry: pl.expiry,
          missionId: event.missionId ?? null,
          taskId: event.taskId ?? null,
          reason: pl.reason ?? null,
          createdAt: at,
          updatedAt: at,
          version: 0,
        });
        return;
      }
      case "approval.decided": {
        const pl = p as EventPayloadMap["approval.decided"];
        const a = this.existing(this.approvals, pl.approvalId);
        this.approvals.set(
          a.id,
          bump(a, at, {
            status: pl.decision,
            actor: pl.actor,
            ...(pl.reason !== undefined ? { reason: pl.reason } : {}),
          }),
        );
        return;
      }
      case "approval.expired": {
        const pl = p as EventPayloadMap["approval.expired"];
        const a = this.existing(this.approvals, pl.approvalId);
        this.approvals.set(a.id, bump(a, at, { status: "expired" }));
        return;
      }
      case "approval.consumed": {
        const pl = p as EventPayloadMap["approval.consumed"];
        const meta = this.approvalMeta.get(pl.approvalId);
        if (meta) this.approvalMeta.set(pl.approvalId, { ...meta, consumed: true });
        return;
      }
      case "git.worktree_created": {
        const pl = p as EventPayloadMap["git.worktree_created"];
        if (pl.baseRef !== undefined) this.worktreeBaseRefs.set(pl.worktreeId, pl.baseRef);
        this.worktrees.set(pl.worktreeId, {
          id: pl.worktreeId,
          taskId: this.need(event.taskId) as Worktree["taskId"],
          path: pl.path,
          branch: pl.branch,
          baseSha: pl.baseSha,
          status: "active",
          createdAt: at,
          updatedAt: at,
          version: 0,
        });
        return;
      }
      case "git.worktree_removed":
      case "git.conflict_detected": {
        const pl = p as { worktreeId?: string };
        const w = this.existing(this.worktrees, this.need(pl.worktreeId));
        const status = type === "git.worktree_removed" ? "removed" : "conflicted";
        this.worktrees.set(w.id, bump(w, at, { status }));
        return;
      }
      default:
        // Observational events (tool.*, test.*, budget.*, policy.*, recovery.*, summary.*,
        // artifact.*, session.output, git.commit_observed) do not change projected entities.
        return;
    }
  }

  private applyTask(event: EventEnvelope, type: EventType, p: Record<string, unknown>): void {
    const id = this.need(event.taskId);
    const t = this.existing(this.tasks, id);
    const at = event.occurredAt;
    const to = p["to"] as Task["status"];
    const patch: Partial<Task> = { status: to };
    if (type === "task.completed" && typeof p["resultCommit"] === "string")
      patch.resultCommit = p["resultCommit"];
    if (type === "task.leased") {
      const pl = p as EventPayloadMap["task.leased"];
      // The payload carries the 1-based attempt number; Task.attempt is the 0-based index.
      Object.assign(patch, {
        agentId: pl.agentId,
        attempt: pl.attempt - 1,
        leaseExpiresAt: pl.leaseExpiresAt,
      });
      // The scheduler leases an unassigned task to a crew: the envelope names it.
      if (event.crewId !== undefined && t.crewId === null) {
        patch.crewId = event.crewId as Task["crewId"];
        const limit = this.crews.get(event.crewId)?.limits.maxAttemptsPerTask;
        if (limit !== undefined) patch.maxAttempts = limit;
      }
    } else if (type === "task.started") {
      const pl = p as EventPayloadMap["task.started"];
      patch.agentId = pl.agentId;
      // verifying -> running is a verification retry: the machine starts the next attempt.
      if (pl.from === "verifying") patch.attempt = t.attempt + 1;
      this.upsertAgent(t, pl.agentId, pl.sessionId, at);
    } else if (type === "task.failed") {
      patch.attempt = (p as EventPayloadMap["task.failed"]).attempt;
    } else if (type === "task.retried") {
      Object.assign(patch, {
        attempt: (p as EventPayloadMap["task.retried"]).attempt,
        agentId: null,
        leaseExpiresAt: null,
      });
    }
    if (to === "completed" || to === "failed" || to === "cancelled" || to === "ready") {
      patch.leaseExpiresAt = null;
    }
    if (type === "task.blocked")
      patch.blockedReason = (p as EventPayloadMap["task.blocked"]).reason;
    const next = bump(t, at, patch);
    if (to !== "blocked") delete next.blockedReason;
    this.tasks.set(id, next);
  }

  private upsertAgent(task: Task, agentId: Agent["id"], sessionId: string, at: string): void {
    const session = this.sessions.get(sessionId);
    const crewId = task.crewId ?? (session?.crewId as Agent["crewId"] | null | undefined) ?? null;
    if (crewId === null) return; // Agent.crewId is required; nothing to attribute it to yet.
    const agentKind = session?.agentKind ?? "unknown";
    const member = [...this.crewMembers.values()].find(
      (m) => m.crewId === crewId && m.agentKind === agentKind,
    );
    const prev = this.agents.get(agentId);
    const fields = {
      crewId,
      role: member?.role ?? prev?.role ?? DEFAULT_ROLE,
      agentKind,
      runtimeSessionId: sessionId as Agent["runtimeSessionId"],
      status: session?.state ?? "starting",
      taskId: task.id,
    };
    this.agents.set(
      agentId,
      prev
        ? bump(prev, at, fields)
        : { id: agentId, ...fields, createdAt: at, updatedAt: at, version: 0 },
    );
  }

  private updateSession(event: EventEnvelope, patch: Partial<SessionView>): void {
    const id = this.need(event.sessionId);
    const s = this.existing(this.sessions, id);
    const next = { ...s, ...patch, updatedAt: event.occurredAt };
    this.sessions.set(id, next);
    for (const agent of this.agents.values()) {
      if (agent.runtimeSessionId === id && agent.status !== next.state) {
        this.agents.set(agent.id, bump(agent, event.occurredAt, { status: next.state }));
      }
    }
  }

  private need(id: string | undefined): string {
    if (id === undefined) throw new Skip("missing entity id");
    return id;
  }

  private existing<T>(map: Map<string, T>, id: string): T {
    const v = map.get(id);
    if (v === undefined) throw new Skip(`unknown entity ${id}`);
    return v;
  }
}
