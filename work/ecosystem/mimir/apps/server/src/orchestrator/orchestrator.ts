import {
  APPROVAL_REQUIRED,
  ApprovalService,
  POLICY_DENIED,
  UNKNOWN_AFTER_RESTART,
  attemptsLeft,
  budgetGuard,
  classifyCommand,
  evaluate,
  isParked,
  leaseTtlMs,
  readyTasks,
  redact,
  schedule,
  taskMachine,
  type Actor,
  type ApprovalRecord,
  type BudgetPolicy,
  type Decision,
  type EventStore,
  type Lease,
  type PolicyRule,
  type PrivilegedAction,
  type TaskEvent,
} from "@mimir/core";
import {
  ArtifactKindSchema,
  MimirError,
  isMimirError,
  type ArtifactKind,
  newId,
  type Approval,
  type BudgetPolicy as ProtocolBudgetPolicy,
  type Crew,
  type CrewMember,
  type EventType,
  type Mission,
  type Project,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeSessionState,
  type Task,
  type Worktree,
} from "@mimir/protocol";
import { emit, type EmitInput } from "../emit.js";
import type { ReadModel } from "../readmodel.js";
import { argvFor } from "../templates.js";
import type { ArtifactStore } from "./artifacts.js";
import type { PersistedWorktree, WorktreePort } from "./git-port.js";
import type { PrRunner } from "./pr.js";
import { missionTransition, taskTransition, type TaskEventContext } from "./transitions.js";
import { collectArtifactFiles, recordCollection } from "./collect.js";
import {
  MAX_CHECK_OUTPUT,
  type VerificationResult,
  type Verifier,
  type VerifyBinding,
} from "./verifier.js";
import {
  argvDigest,
  classifiedArgv,
  classifyOptions,
  memberOf,
  projectSettings,
  testCommandOf,
} from "./commands.js";

export const DEFAULT_TICK_MS = 1000;
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Keys sent to accept Claude Code's folder-trust dialog once a human approves it (unverified live). */
export const TRUST_PROMPT_ACCEPT_KEYS: readonly string[] = ["enter"];
export const TRUST_PROMPT_STATUS = "blocked:trust_prompt";
/** Test output kept inline in `test.run_completed` (the full output is an artifact). */
export const EVENT_OUTPUT_CAP = 16 * 1024;
/** Ticks between periodic `runtime.reconcile()` liveness checks (0 disables them). */
export const DEFAULT_RECONCILE_EVERY_TICKS = 30;

/** The system actor that requests approvals for actions an operator asked for. */
export const SYSTEM_ACTOR: Actor = { kind: "system", id: "mimir" };
/** Single-token auth has one human identity: the operator. */
export const OPERATOR: Actor = { kind: "human", id: "operator" };

const LIVE_SESSION_STATES: ReadonlySet<RuntimeSessionState> = new Set([
  "requested",
  "starting",
  "idle",
  "running",
  "waiting",
  "blocked",
  "stopping",
]);
const TERMINAL_SESSION_STATES: ReadonlySet<RuntimeSessionState> = new Set([
  "stopped",
  "completed",
  "failed",
]);
const LEASE_HOLDING: ReadonlySet<Task["status"]> = new Set([
  "leased",
  "running",
  "verifying",
  "blocked",
]);

export interface OrchestratorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const NOOP_LOG: OrchestratorLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface OrchestratorOptions {
  store: EventStore;
  readModel: ReadModel;
  runtime: RuntimeAdapter | null;
  git: WorktreePort;
  verifier: Verifier;
  artifacts: ArtifactStore;
  policies: readonly PolicyRule[];
  now: () => Date;
  pr: PrRunner;
  /** 0 disables the interval loop (call `tick()` yourself). */
  tickMs?: number;
  approvalTtlMs?: number;
  /** Run `runtime.reconcile()` every N ticks to catch sessions lost without an event (I5). */
  reconcileEveryTicks?: number;
  log?: OrchestratorLogger;
}

/** Outcome of the policy gate for one action instance (see `gate`). */
type GateResult =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "approved"; approval: Approval }
  | { kind: "approval_required"; pending: Approval | undefined };

/** Outcome of an operator request that may need an approval first. */
export type GatedOutcome =
  | { kind: "done" }
  | { kind: "approval_required"; approval: Approval }
  | { kind: "denied"; reason: string };

const slug = (text: string, fallback: string): string => {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s.length > 0 ? s : fallback;
};

/** Protocol budget (zod optional fields) → core `BudgetPolicy` (exact optional fields). */
export function toBudgetPolicy(b: ProtocolBudgetPolicy): BudgetPolicy {
  const { enforce, onUnknown, ...rest } = b;
  return {
    ...rest,
    ...(enforce !== undefined ? { enforce } : {}),
    ...(onUnknown !== undefined ? { onUnknown } : {}),
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Joins scheduler, policy, git, runtime, store and read model. Every state change is appended to
 * the event store first; the read model then updates from the event (via `store.subscribe`).
 * All mutations run on one serial queue, so decisions never interleave.
 */
export class Orchestrator {
  private readonly store: EventStore;
  private readonly rm: ReadModel;
  private readonly runtime: RuntimeAdapter | null;
  private readonly git: WorktreePort;
  private readonly verifier: Verifier;
  private readonly artifacts: ArtifactStore;
  private readonly policies: readonly PolicyRule[];
  private readonly now: () => Date;
  private readonly pr: PrRunner;
  private readonly tickMs: number;
  private readonly approvalTtlMs: number;
  private readonly reconcileEveryTicks: number;
  private readonly log: OrchestratorLogger;
  /** Last runtime observation of each session (server clock ms): events and reconcile presence. */
  private readonly heartbeats = new Map<string, number>();
  private tickCount = 0;

  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly verifications = new Map<string, AbortController>();
  /** In-memory lease renewals (heartbeats) per task, as ISO expiry. */
  private readonly renewals = new Map<string, string>();
  /** Expired leases already handled (`taskId@expiresAt`), so expire/release fire once per lease. */
  private readonly handledLeases = new Set<string>();
  private subscription: { close(): void } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private runtimeName = "runtime";
  private stopped = false;

  constructor(options: OrchestratorOptions) {
    this.store = options.store;
    this.rm = options.readModel;
    this.runtime = options.runtime;
    this.git = options.git;
    this.verifier = options.verifier;
    this.artifacts = options.artifacts;
    this.policies = options.policies;
    this.now = options.now;
    this.pr = options.pr;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
    this.reconcileEveryTicks = options.reconcileEveryTicks ?? DEFAULT_RECONCILE_EVERY_TICKS;
    this.log = options.log ?? NOOP_LOG;
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle

  /** Boot recovery (before the first tick), runtime subscription, then the tick loop. */
  async start(): Promise<void> {
    if (this.runtime) {
      try {
        this.runtimeName = (await this.runtime.capabilities()).runtime;
      } catch (err) {
        this.log.warn({ err: message(err) }, "runtime capabilities unavailable");
      }
      this.subscription = await this.runtime.subscribe((e) => {
        void this.enqueue(() => this.onRuntimeEvent(e)).catch((err: unknown) =>
          this.log.error({ err: message(err), kind: e.kind }, "runtime event handling failed"),
        );
      });
    }
    await this.enqueue(() => this.recover("boot"));
    if (this.tickMs > 0) {
      this.timer = setInterval(() => {
        if (this.ticking) return;
        this.ticking = true;
        this.tick()
          .catch((err: unknown) => this.log.error({ err: message(err) }, "tick failed"))
          .finally(() => {
            this.ticking = false;
          });
      }, this.tickMs);
      this.timer.unref?.();
    }
  }

  /** Stops the loop and the subscription; waits (bounded) for in-flight work to settle. */
  async stop(graceMs = 5000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subscription?.close();
    this.subscription = null;
    for (const ac of this.verifications.values()) ac.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.idle().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** One scheduling pass. */
  tick(): Promise<void> {
    return this.enqueue(() => this.doTick());
  }

  /** Resolves once the queue is drained and no verification is in flight. */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await chain.catch(() => undefined);
      await Promise.allSettled([...this.inflight]);
      if (this.chain === chain && this.inflight.size === 0) return;
    }
  }

  /** Runs `fn` on the serial queue. */
  enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.catch((err: unknown) =>
      this.log.error({ err: message(err) }, "background work failed"),
    );
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
  }

  // ---------------------------------------------------------------------------------------------
  // Tick

  private async doTick(): Promise<void> {
    if (this.stopped) return;
    this.tickCount += 1;
    const dueHeartbeat = [...this.rm.tasks.values()].some((task) => {
      if (!["running", "leased"].includes(task.status) || !task.crewId) return false;
      const crew = this.rm.crews.get(task.crewId);
      const session = this.currentSession(task.id);
      const seen = session ? this.heartbeats.get(session) : undefined;
      return (
        crew !== undefined &&
        seen !== undefined &&
        this.now().getTime() - seen >= leaseTtlMs(crew) / 2
      );
    });
    if (
      this.reconcileEveryTicks > 0 &&
      (this.tickCount % this.reconcileEveryTicks === 0 || dueHeartbeat)
    ) {
      await this.recover("periodic");
    }
    const now = this.now();
    this.expireApprovals(now);
    this.promoteReady(now);
    const decisions = schedule({
      now,
      missions: [...this.rm.missions.values()],
      crews: [...this.rm.crews.values()],
      tasks: [...this.rm.tasks.values()],
      deps: [...this.rm.taskDependencies.values()],
      leases: this.leases(now),
      usage: [...this.rm.usageSamples.values()],
      budgets: [...this.rm.budgets.values()].map(toBudgetPolicy),
      agents: [...this.rm.agents.values()].map((a) => ({ id: a.id, crewId: a.crewId })),
    });
    for (const d of decisions) {
      try {
        await this.apply(d, now);
      } catch (err) {
        this.log.error({ err: message(err), decision: d }, "decision failed");
      }
    }
    this.checkBudgets(now);
  }

  private promoteReady(now: Date): void {
    const active = new Set(
      [...this.rm.missions.values()].filter((m) => m.status === "active").map((m) => m.id),
    );
    const tasks = [...this.rm.tasks.values()].filter((t) => active.has(t.missionId));
    for (const t of readyTasks(tasks, [...this.rm.taskDependencies.values()])) {
      this.taskEvent(now, t, { type: "deps_completed" });
    }
  }

  private leases(now: Date): Lease[] {
    const out: Lease[] = [];
    for (const task of this.rm.tasks.values()) {
      if (task.leaseExpiresAt === null || task.crewId === null) continue;
      if (!LEASE_HOLDING.has(task.status)) continue;
      const crew = this.rm.crews.get(task.crewId);
      const sessionId = this.currentSession(task.id);
      const session = sessionId ? this.rm.sessions.get(sessionId) : undefined;
      let expiresAt = this.renewals.get(task.id) ?? task.leaseExpiresAt;
      // Renew only on runtime truth: a live session state that the runtime itself reported
      // (event or periodic reconcile) within the lease ttl. "requested" is Mimir's own intent.
      const seen = sessionId ? this.heartbeats.get(sessionId) : undefined;
      const fresh =
        seen !== undefined && crew !== undefined && now.getTime() - seen < leaseTtlMs(crew);
      const alive =
        task.status === "verifying" ||
        (session !== undefined &&
          session.state !== "requested" &&
          LIVE_SESSION_STATES.has(session.state) &&
          fresh &&
          !isParked(task));
      if (alive && crew) {
        // Heartbeat: a session the runtime still reports alive keeps its task's lease.
        expiresAt = new Date(now.getTime() + leaseTtlMs(crew)).toISOString();
        this.renewals.set(task.id, expiresAt);
      }
      if (this.handledLeases.has(`${task.id}@${expiresAt}`)) continue;
      out.push({
        taskId: task.id,
        crewId: task.crewId,
        sessionId: (sessionId ?? null) as Lease["sessionId"],
        expiresAt,
        heartbeatAt: now.toISOString(),
      });
    }
    return out;
  }

  private async apply(d: Decision, now: Date): Promise<void> {
    switch (d.kind) {
      case "dispatch": {
        if (!this.runtime) return; // no runtime configured: nothing can run
        const task = this.rm.tasks.get(d.taskId);
        if (task?.status === "ready") await this.dispatch(task, d.crewId, now);
        return;
      }
      case "expire": {
        const task = this.rm.tasks.get(d.taskId);
        if (!task) return;
        this.handledLeases.add(`${task.id}@${this.renewals.get(task.id) ?? task.leaseExpiresAt}`);
        this.renewals.delete(task.id);
        this.taskEvent(now, task, { type: "lease_expired" }, { reason: "lease_expired" });
        const sessionId = this.currentSession(task.id);
        if (sessionId && this.runtime) {
          void this.runtime.requestStop(sessionId, "soft").catch(() => undefined);
        }
        return;
      }
      case "release_lease": {
        const task = this.rm.tasks.get(d.taskId);
        this.handledLeases.add(
          `${d.taskId}@${this.renewals.get(d.taskId) ?? task?.leaseExpiresAt ?? ""}`,
        );
        this.renewals.delete(d.taskId);
        return;
      }
      case "retry": {
        const task = this.rm.tasks.get(d.taskId);
        if (task) this.taskEvent(now, task, { type: "retry" });
        return;
      }
      case "block": {
        const task = this.rm.tasks.get(d.taskId);
        if (task) this.taskEvent(now, task, { type: "budget_exceeded", reason: d.reason });
        return;
      }
      case "unblock": {
        const task = this.rm.tasks.get(d.taskId);
        if (task) this.taskEvent(now, task, { type: "budget_restored" });
        return;
      }
      case "mission_complete": {
        const mission = this.rm.missions.get(d.missionId);
        if (!mission) return;
        const tasks = [...this.rm.tasks.values()].filter((t) => t.missionId === mission.id);
        this.missionEvent(now, mission, { type: "complete", tasks });
        return;
      }
      case "mission_failed": {
        const mission = this.rm.missions.get(d.missionId);
        if (mission) this.missionEvent(now, mission, { type: "fail", reason: "tasks_failed" });
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Dispatch

  private memberFor(crew: Crew): CrewMember {
    const member = memberOf(this.rm, crew.id);
    if (!member) throw new MimirError("conflict", `crew ${crew.id} has no members`);
    return member;
  }

  /** The argv a task's session runs, and what the policy gate classifies (see `classifiedArgv`). */
  private commandFor(
    task: Task,
    member: CrewMember,
  ): { argv: string[]; classify: string[] | null } {
    const spec = this.rm.taskSpec(task.id);
    const brief = spec.brief ?? [task.title, task.acceptance].filter((s) => s !== "").join("\n\n");
    const argv = spec.argv ?? argvFor(member.agentKind, member.role, brief);
    return {
      argv,
      classify: classifiedArgv(
        argv,
        spec.argv !== undefined,
        member.agentKind,
        argvFor(member.agentKind, member.role, brief),
      ),
    };
  }

  /** Path and branch of a task's worktree: the existing one, else where `create` will put it. */
  private worktreePlan(task: Task, project: Project, crew: Crew): { path: string; branch: string } {
    const existing = this.activeWorktree(task.id);
    if (existing) return { path: existing.path, branch: existing.branch };
    return this.git.plan({
      projectId: project.id as never,
      taskId: task.id,
      crewSlug: slug(crew.template, "crew"),
      taskSlug: slug(task.title, "task"),
    });
  }

  private async dispatch(task: Task, crewId: string, now: Date): Promise<void> {
    const crew = this.rm.crews.get(crewId);
    const mission = this.rm.missions.get(task.missionId);
    const project = mission ? this.rm.projects.get(mission.projectId) : undefined;
    if (!crew || !mission || !project) {
      this.log.warn(
        { taskId: task.id, crewId },
        "dispatch skipped: crew, mission or project missing",
      );
      return;
    }
    const member = this.memberFor(crew);
    const { argv, classify } = this.commandFor(task, member);

    if (classify !== null) {
      const plan = this.worktreePlan(task, project, crew);
      const action = classifyCommand(classify, classifyOptions(project, plan.path, plan.branch));
      if (action !== null) {
        const actor: Actor = { kind: "agent", id: member.id, crewId: crew.id, role: member.role };
        const subject = `dispatch:${task.id}:${task.attempt}:${argvDigest(argv)}`;
        const gate = this.gate(now, action, actor, project.id, subject);
        if (gate.kind === "deny") {
          this.policyDenied(now, action, gate.reason, { taskId: task.id, missionId: mission.id });
          this.taskEvent(now, task, { type: "dispatch_gated", reason: POLICY_DENIED });
          return;
        }
        if (gate.kind === "approval_required") {
          if (!gate.pending) {
            this.requestApproval(now, {
              action,
              requestedBy: actor,
              missionId: mission.id,
              taskId: task.id,
              subject,
              summary: `dispatch task "${task.title}" (attempt ${task.attempt + 1}) running ${JSON.stringify(redact(JSON.stringify(argv)).text)} (${action})`,
            });
          }
          this.taskEvent(now, task, { type: "dispatch_gated", reason: APPROVAL_REQUIRED });
          return;
        }
        if (gate.kind === "approved") this.consume(now, gate.approval);
      }
    }

    // Lease (in the queue); worktree and session creation run off the queue (see `launch`).
    const agentId = newId("agt");
    const ttl = leaseTtlMs(crew);
    const leaseExpiresAt = new Date(now.getTime() + ttl).toISOString();
    const leased = this.taskEvent(
      now,
      task,
      { type: "lease_granted", crewId: crew.id as Task["crewId"], leaseExpiresAt },
      { agentId },
    );
    this.renewals.delete(task.id);
    this.launch({
      taskId: task.id,
      project,
      crew,
      member,
      agentId,
      attemptNumber: leased.attempt + 1,
      argv,
      expect: "leased",
      event: { type: "session_started", agentId: agentId as never },
    });
  }

  /**
   * Worktree → `session.requested` → `runtime.createSession` → `task.started`. Git and runtime
   * calls run outside the serial queue (a slow `agent.wait` must not stall the orchestrator);
   * every event is appended from inside the queue after re-checking that the task still expects
   * this launch (it may have been cancelled meanwhile).
   */
  private launch(input: {
    taskId: string;
    project: Project;
    crew: Crew;
    member: CrewMember;
    agentId: string;
    attemptNumber: number;
    argv: string[];
    /** Task status this launch belongs to: `leased` (dispatch) or `verifying` (next attempt). */
    expect: "leased" | "verifying";
    /** `session_started` (leased → running) or `verification_failed` (verifying → running). */
    event: TaskEvent;
  }): void {
    const stillOurs = (): Task | null => {
      const t = this.rm.tasks.get(input.taskId);
      if (!t || t.status !== input.expect) return null;
      if (input.expect === "leased" && t.agentId !== input.agentId) return null;
      return t;
    };
    const failTask = (reason: string) => {
      const now = this.now();
      let current = stillOurs();
      if (!current) return;
      if (current.status === "verifying") {
        // verification_failed (attempts left) → running on the next attempt, which then fails
        current = this.taskEvent(now, current, input.event, {
          agentId: input.agentId,
          sessionId: this.currentSession(current.id),
        });
      }
      if (taskMachine.can(current, "runtime_failed")) {
        this.taskEvent(now, current, { type: "runtime_failed", reason }, { reason });
      }
    };
    const runtime = this.runtime;
    this.track(
      (async () => {
        // 1. worktree (reuse the task's own on later attempts)
        let worktree = [...this.rm.worktrees.values()].find(
          (w) => w.taskId === input.taskId && w.status !== "removed" && this.git.has(w.id),
        );
        if (!worktree) {
          let created: Worktree;
          try {
            const dependencies = [...this.rm.taskDependencies.values()]
              .filter((d) => d.taskId === input.taskId)
              .map((d) => d.dependsOnId);
            const dependencyBase = await this.git.dependencyBase(
              input.project.id,
              input.project.repoPath,
              dependencies.map((id) => {
                const commit = this.task(id).resultCommit;
                if (!commit)
                  throw new Error(`dependency ${id} has no immutable verified result; rerun it`);
                return commit;
              }),
            );
            created = await this.git.create({
              ...(dependencyBase ? { baseRef: dependencyBase } : {}),
              projectId: input.project.id as never,
              repoPath: input.project.repoPath,
              taskId: input.taskId as never,
              crewSlug: slug(input.crew.template, "crew"),
              taskSlug: slug(this.task(input.taskId).title, "task"),
            });
          } catch (err) {
            await this.enqueue(() => {
              if (!this.stopped) failTask(`worktree_failed: ${message(err)}`);
            });
            return;
          }
          // The worktree exists on disk now: record it even if the task moved on.
          const baseRef = this.git.baseRefOf(created.id);
          await this.enqueue(() => {
            const t = this.task(input.taskId);
            this.emit(this.now(), {
              type: "git.worktree_created",
              streamId: `task:${t.id}`,
              taskId: t.id,
              missionId: t.missionId,
              crewId: input.crew.id,
              payload: {
                worktreeId: created.id,
                path: created.path,
                branch: created.branch,
                baseSha: created.baseSha,
                ...(baseRef !== undefined ? { baseRef } : {}),
              },
            });
          });
          worktree = created;
        }
        const cwd = worktree.path;

        // 2. session.requested
        const sessionId = newId("ses");
        const title = this.task(input.taskId).title;
        const workspaceLabel = `mimir/${slug(input.crew.template, "crew")}/${slug(title, "task")}`;
        const missionId = this.task(input.taskId).missionId;
        const ids = { sessionId, taskId: input.taskId, missionId, crewId: input.crew.id };
        const requested = await this.enqueue(() => {
          if (this.stopped || !stillOurs()) return false;
          this.emit(this.now(), {
            type: "session.requested",
            streamId: `session:${sessionId}`,
            ...ids,
            payload: {
              agentKind: input.member.agentKind,
              crewId: input.crew.id as never,
              taskId: input.taskId as never,
              workspaceLabel,
            },
          });
          return true;
        });
        if (!requested) return;

        // 3. runtime.createSession (off the queue)
        const failSession = (err: unknown) =>
          this.enqueue(() => {
            if (this.stopped) return;
            this.emit(this.now(), {
              type: "session.state_changed",
              streamId: `session:${sessionId}`,
              ...ids,
              payload: {
                from: this.rm.sessions.get(sessionId)?.state ?? "requested",
                to: "failed",
                runtimeStatus: `create_failed: ${message(err)}`,
              },
            });
            failTask(`session_create_failed: ${message(err)}`);
          });
        if (!runtime) {
          await failSession(new MimirError("runtime_unavailable", "no runtime configured"));
          return;
        }
        let session: RuntimeSession;
        try {
          session = await runtime.createSession({
            sessionId,
            idempotencyKey: `${input.taskId}:${input.attemptNumber}`,
            crewId: input.crew.id,
            taskId: input.taskId,
            agentKind: input.member.agentKind,
            argv: input.argv,
            ...(this.task(input.taskId).timeoutMs !== undefined
              ? { timeoutMs: this.task(input.taskId).timeoutMs! }
              : {}),
            cwd,
            env: { MIMIR_TASK_ID: input.taskId, MIMIR_MISSION_ID: missionId },
            workspaceLabel,
          });
        } catch (err) {
          await failSession(err);
          return;
        }

        // 4. session.started + task.started, then catch up with states observed meanwhile
        await this.enqueue(async () => {
          // A crash or shutdown here is recovered at boot: the leased task's session is present.
          if (this.stopped) return;
          const now = this.now();
          this.heartbeats.set(sessionId, now.getTime());
          this.emit(now, {
            type: "session.started",
            streamId: `session:${sessionId}`,
            ...ids,
            provenance: "observed",
            source: `runtime:${this.runtimeName}`,
            payload: { runtime: this.runtimeName, runtimeRef: session.runtimeRef },
          });
          const task = stillOurs();
          if (!task) {
            // cancelled (or otherwise moved on) while the session was being created
            await runtime
              .requestStop(sessionId, "soft")
              .catch((err: unknown) =>
                this.log.warn(
                  { sessionId, err: message(err) },
                  "stop of an orphaned session failed",
                ),
              );
            return;
          }
          this.taskEvent(now, task, input.event, { agentId: input.agentId, sessionId });
          const view = this.rm.sessions.get(sessionId);
          if (view && view.state !== "requested" && view.state !== "starting") {
            await this.onSessionState(sessionId, view.state, view.runtimeStatus ?? undefined, now);
          }
        });
      })(),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime events

  private async onRuntimeEvent(e: RuntimeEvent): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    if (e.kind === "runtime.gap") {
      this.log.warn({ reason: e.reason }, "runtime event gap; reconciling");
      await this.recover("gap");
      return;
    }
    const view = this.rm.sessions.get(e.sessionId);
    if (!view) return; // not a Mimir session
    if (e.kind !== "session.lost") this.heartbeats.set(e.sessionId, now.getTime());
    const base = {
      streamId: `session:${e.sessionId}`,
      sessionId: e.sessionId,
      provenance: "observed" as const,
      source: `runtime:${this.runtimeName}`,
      observedAt: e.observedAt,
      ...(view.taskId ? { taskId: view.taskId } : {}),
      ...(view.crewId ? { crewId: view.crewId } : {}),
      ...this.missionOf(view.taskId),
    };
    switch (e.kind) {
      case "session.state_changed": {
        const status = e.runtimeStatus ?? null;
        if (view.state === e.state && view.runtimeStatus === status) return;
        if (TERMINAL_SESSION_STATES.has(view.state)) return; // terminal states are sticky
        this.emit(now, {
          ...base,
          type: "session.state_changed",
          ...(e.sourceEventId !== undefined
            ? { sourceEventId: `${e.sessionId}:${e.sourceEventId}` }
            : {}),
          payload: {
            from: view.state,
            to: e.state,
            ...(e.runtimeStatus !== undefined ? { runtimeStatus: e.runtimeStatus } : {}),
          },
        });
        await this.onSessionState(e.sessionId, e.state, e.runtimeStatus, now);
        return;
      }
      case "session.output": {
        const r = redact(e.text);
        this.emit(now, {
          ...base,
          type: "session.output",
          payload: { text: r.text, redacted: r.redacted, lines: r.text.split("\n").length },
        });
        return;
      }
      case "session.exited":
        if (e.usage) this.recordUnavailableUsage(e.sessionId, now, e.usage);
        this.emit(now, {
          ...base,
          type: "session.exited",
          payload: e.exitCode !== undefined ? { exitCode: e.exitCode } : {},
        });
        return;
      case "session.lost": {
        if (view.lostReason !== null) return;
        this.emit(now, { ...base, type: "session.lost", payload: { reason: e.reason } });
        this.onSessionLost(e.sessionId, `session_lost: ${e.reason}`, now);
        return;
      }
    }
  }

  /** Task reaction to a session state, for the task's current session only. */
  private async onSessionState(
    sessionId: string,
    state: RuntimeSessionState,
    runtimeStatus: string | undefined,
    now: Date,
  ): Promise<void> {
    const view = this.rm.sessions.get(sessionId);
    if (TERMINAL_SESSION_STATES.has(state)) this.recordUnavailableUsage(sessionId, now);
    if (!view?.taskId || this.currentSession(view.taskId) !== sessionId) return;
    let task = this.task(view.taskId);
    const ctx = { agentId: task.agentId ?? undefined, sessionId };
    const resume = () => {
      if (task.status === "blocked" && taskMachine.can(task, "input_received")) {
        task = this.taskEvent(now, task, { type: "input_received" }, ctx);
      }
    };
    switch (state) {
      case "blocked": {
        if (task.status === "running") {
          task = this.taskEvent(now, task, {
            type: "runtime_blocked",
            reason: runtimeStatus ?? "blocked",
          });
        }
        if (runtimeStatus?.startsWith(TRUST_PROMPT_STATUS) === true) {
          const subject = `trust:${sessionId}`;
          if (!this.bySubject(subject, "pending")) {
            this.requestApproval(now, {
              action: "runtime.accept_trust_prompt",
              requestedBy: SYSTEM_ACTOR,
              missionId: task.missionId,
              taskId: task.id,
              sessionId,
              subject,
              summary: `accept the folder-trust prompt for session ${sessionId} (task "${task.title}")`,
            });
          }
        }
        return;
      }
      case "starting":
      case "idle":
      case "running":
      case "waiting":
        resume();
        return;
      case "completed":
        resume();
        if (task.status === "running") {
          this.taskEvent(now, task, { type: "runtime_completed" });
          this.startVerification(task.id);
        }
        return;
      case "failed":
      case "stopped":
        resume();
        if (task.status === "running" || task.status === "leased") {
          const reason = state === "stopped" ? "session_stopped" : "session_failed";
          this.taskEvent(
            now,
            task,
            { type: "runtime_failed", reason },
            {
              reason: runtimeStatus ? `${reason}: ${runtimeStatus}` : reason,
            },
          );
        }
        return;
      default:
        return;
    }
  }

  private onSessionLost(sessionId: string, reason: string, now: Date): void {
    this.recordUnavailableUsage(sessionId, now);
    const view = this.rm.sessions.get(sessionId);
    if (!view?.taskId || this.currentSession(view.taskId) !== sessionId) return;
    let task = this.task(view.taskId);
    if (task.status === "blocked" && taskMachine.can(task, "input_received")) {
      task = this.taskEvent(
        now,
        task,
        { type: "input_received" },
        {
          agentId: task.agentId ?? undefined,
          sessionId,
        },
      );
    }
    if (taskMachine.can(task, "runtime_lost")) {
      this.taskEvent(now, task, { type: "runtime_lost" }, { reason });
    }
  }

  /** One `unavailable` usage sample per session that ended without measured usage. */
  private recordUnavailableUsage(
    sessionId: string,
    now: Date,
    usage?: { tokens: number; estimatedCost: number | null },
  ): void {
    const agent = [...this.rm.agents.values()].find((a) => a.runtimeSessionId === sessionId);
    const view = this.rm.sessions.get(sessionId);
    const agentId = agent?.id ?? (view?.taskId ? this.rm.tasks.get(view.taskId)?.agentId : null);
    if (!agentId) return;
    const at = now.toISOString();
    this.emit(now, {
      type: "usage.recorded",
      streamId: `session:${sessionId}`,
      sessionId,
      ...(view?.taskId ? { taskId: view.taskId } : {}),
      ...this.missionOf(view?.taskId ?? null),
      // one per session, also across restarts
      sourceEventId: `usage:${sessionId}`,
      payload: {
        sample: {
          id: newId("usg"),
          agentId,
          tokens: usage?.tokens ?? null,
          estimatedCost: usage?.estimatedCost ?? null,
          source: usage ? "measured" : "unavailable",
          createdAt: at,
          updatedAt: at,
          version: 0,
        },
      },
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Verification

  private startVerification(taskId: string): void {
    const ac = new AbortController();
    this.verifications.get(taskId)?.abort();
    this.verifications.set(taskId, ac);
    this.track(
      (async () => {
        const prepared = await this.enqueue(() => this.prepareVerification(taskId));
        if (prepared === null) return;
        let result: VerificationResult | MimirError;
        try {
          result = await this.verifier.verify({ ...prepared, signal: ac.signal });
        } catch (err) {
          result = isMimirError(err) ? err : new MimirError("internal", message(err));
        }
        if (ac.signal.aborted) return;
        await this.enqueue(() => this.finishVerification(taskId, result));
      })().finally(() => {
        if (this.verifications.get(taskId) === ac) this.verifications.delete(taskId);
      }),
    );
  }

  private activeWorktree(taskId: string): Worktree | undefined {
    return [...this.rm.worktrees.values()].find(
      (w) => w.taskId === taskId && w.status !== "removed",
    );
  }

  private async prepareVerification(taskId: string): Promise<
    | (VerifyBinding & {
        testCommand: string[];
        harnessRef?: string;
        taskTitle: string;
        verifierConfig?: unknown;
      })
    | null
  > {
    const task = this.rm.tasks.get(taskId);
    const worktree = this.activeWorktree(taskId);
    if (task?.status !== "verifying" || !worktree) return null;
    const project = this.projectOf(task);
    const now = this.now();
    let headSha: string | null = null;
    if (this.git.has(worktree.id)) {
      try {
        const diff = await this.git.diff(worktree.id);
        this.recordArtifact(now, task, "diff", diff.patch);
        const manifest = await this.git.changedFilesManifest(worktree.id);
        this.recordArtifact(now, task, "changed-files", JSON.stringify(manifest, null, 2));
        headSha = manifest.headSha;
      } catch (err) {
        this.log.warn({ taskId, err: message(err) }, "diff for verification failed");
      }
    }
    // The test command runs in the agent's worktree: classify and gate it like any command (C2).
    const testCommand = testCommandOf(project);
    const action =
      (task.verification ?? projectSettings(project).verification) !== undefined
        ? null
        : classifyCommand(testCommand, classifyOptions(project, worktree.path, worktree.branch));
    if (action !== null) {
      const subject = `verify:${task.id}:${task.attempt}:${argvDigest(testCommand)}`;
      const gate = this.gate(now, action, SYSTEM_ACTOR, project?.id, subject);
      if (gate.kind === "deny") {
        this.taskEvent(now, task, { type: "verification_gated" });
        this.policyDenied(now, action, `test command: ${gate.reason}`, {
          taskId: task.id,
          missionId: task.missionId,
        });
        return null;
      }
      if (gate.kind === "approval_required") {
        if (!gate.pending) {
          this.requestApproval(now, {
            action,
            requestedBy: SYSTEM_ACTOR,
            missionId: task.missionId,
            taskId: task.id,
            subject,
            summary: `verify task "${task.title}" by running ${redact(JSON.stringify(testCommand)).text} (${action})`,
          });
        }
        return null;
      }
      if (gate.kind === "approved") this.consume(now, gate.approval);
    }
    const harnessRef = projectSettings(project).harnessRef;
    // Files the agent left under <worktree>/.mimir/artifacts/ (bounded, no symlinks), recorded
    // once the verification actually runs.
    recordCollection(collectArtifactFiles(worktree.path), {
      task,
      write: (content) => this.artifacts.write(content),
      emit: (input) => this.emit(now, input),
    });
    // Opaque to Mimir: the configured verifier (Brokkr) reads it.
    const verifierConfig = task.verification ?? projectSettings(project).verification;
    return {
      taskId: task.id,
      taskTitle: task.title,
      ...(verifierConfig !== undefined ? { verifierConfig } : {}),
      missionId: task.missionId,
      worktreePath: worktree.path,
      baseRef: worktree.baseSha,
      headSha,
      testCommand,
      ...(harnessRef !== undefined ? { harnessRef } : {}),
    };
  }

  private async finishVerification(
    taskId: string,
    result: VerificationResult | MimirError,
  ): Promise<void> {
    const now = this.now();
    let task = this.task(taskId);
    if (task.status !== "verifying") return;
    let passed = false;
    let reason = "verification_failed";
    if (result instanceof MimirError) {
      reason = `verification_error: ${result.code}: ${result.message}`;
      this.log.warn({ taskId, err: result.message }, "verifier failed");
    } else {
      passed = result.passed;
      for (const check of result.checks) {
        this.recordArtifact(now, task, "test.output", check.output);
        const redacted = redact(check.output).text;
        const output =
          redacted.length > EVENT_OUTPUT_CAP
            ? `${redacted.slice(0, EVENT_OUTPUT_CAP)}\n[truncated]`
            : redacted;
        this.emit(now, {
          type: "test.run_completed",
          streamId: `task:${task.id}`,
          taskId: task.id,
          missionId: task.missionId,
          provenance: "observed",
          payload: {
            command: redact(check.command.join(" ")).text,
            passed: check.passed,
            durationMs: check.durationMs,
            exitCode: check.exitCode,
            output: output.slice(0, MAX_CHECK_OUTPUT),
          },
        });
      }
      if (result.source === "brokkr" && result.report !== undefined) {
        this.recordArtifact(now, task, "brokkr.verification-report", JSON.stringify(result.report));
      }
    }
    if (passed) {
      let resultCommit: string;
      const worktree = this.activeWorktree(taskId);
      try {
        if (!worktree) throw new Error("verified task has no worktree");
        const commit = await this.git.checkpoint(worktree.id);
        resultCommit = commit;
        this.recordArtifact(
          now,
          task,
          "file",
          JSON.stringify({ kind: "verified-result", commit, worktreeId: worktree.id }),
        );
      } catch (err) {
        const reason = `checkpoint_failed: ${message(err)}`;
        const failed = this.taskEvent(now, task, { type: "verification_failed" }, { reason });
        if (failed.status === "running")
          this.taskEvent(now, failed, { type: "runtime_failed", reason });
        return;
      }
      this.taskEvent(now, task, { type: "verification_passed" }, { resultCommit });
      this.renewals.delete(task.id);
      return;
    }
    if (!attemptsLeft(task)) {
      this.taskEvent(now, task, { type: "verification_failed" }, { reason });
      this.renewals.delete(task.id);
      return;
    }
    // Attempts left: the machine sends the task back to work on its next attempt, in a new
    // session in the same worktree.
    task = this.task(taskId);
    const crew = task.crewId ? this.rm.crews.get(task.crewId) : undefined;
    const project = this.projectOf(task);
    if (!crew || !project) {
      this.log.warn({ taskId }, "cannot start the next attempt: crew or project missing");
      return;
    }
    const member = this.memberFor(crew);
    const { argv, classify } = this.commandFor(task, member);
    if (
      classify !== null &&
      classifyCommand(
        classify,
        classifyOptions(
          project,
          this.worktreePlan(task, project, crew).path,
          this.worktreePlan(task, project, crew).branch,
        ),
      ) !== null
    ) {
      // A previous attempt's approval is spent. Re-enter scheduling so the next attempt
      // is evaluated under current policy and receives its own approval if required.
      const parked = this.taskEvent(now, task, { type: "verification_gated" });
      this.taskEvent(now, parked, { type: "retry" });
      return;
    }
    this.launch({
      taskId,
      project,
      crew,
      member,
      agentId: task.agentId ?? newId("agt"),
      // Task.attempt is 0-based; the next attempt's number is attempt + 2
      attemptNumber: task.attempt + 2,
      argv,
      expect: "verifying",
      event: { type: "verification_failed" },
    });
  }

  private recordArtifact(now: Date, task: Task, kind: ArtifactKind, content: string): string {
    ArtifactKindSchema.parse(kind);
    if (kind === "local_delivery" && redact(content).redacted)
      throw new MimirError(
        "conflict",
        "local export contains credential-shaped content; remove it and rerun verification before exporting",
      );
    // Artifacts are served to other consumers: secrets are masked before the content is written.
    const a = this.artifacts.write(redact(content).text);
    this.emit(now, {
      type: "artifact.recorded",
      streamId: `task:${task.id}`,
      taskId: task.id,
      missionId: task.missionId,
      payload: {
        artifactId: a.id as never,
        taskId: task.id,
        kind,
        uri: a.uri,
        hash: a.hash,
        bytes: a.bytes,
      },
    });
    return a.id;
  }

  // ---------------------------------------------------------------------------------------------
  // Recovery

  /**
   * Reconciliation with the runtime's own view.
   * - `boot`: leased, running and runtime-blocked tasks whose session is gone are parked
   *   `unknown_after_restart` (never auto-completed). A leased task whose session exists (a crash
   *   between createSession and task.started) is started. Present sessions are re-bound by syncing
   *   their state, and verifying tasks re-run verification.
   * - `gap` / `periodic`: sessions the runtime no longer has are lost; their tasks fail and are
   *   retried. Presence refreshes lease heartbeats (I5).
   */
  private async recover(mode: "boot" | "gap" | "periodic"): Promise<void> {
    const now = this.now();
    if (mode === "boot") await this.restoreWorktrees();
    if (!this.runtime) return;
    let reconciled: { sessions: RuntimeSession[]; lost: string[] };
    try {
      reconciled = await this.runtime.reconcile();
    } catch (err) {
      this.log.error({ err: message(err) }, "runtime reconcile failed");
      return;
    }
    const present = new Map(reconciled.sessions.map((s) => [s.sessionId, s]));
    for (const id of present.keys()) this.heartbeats.set(id, now.getTime());
    const lostIds: string[] = [];
    for (const task of [...this.rm.tasks.values()]) {
      const recoverable =
        task.status === "leased" ||
        task.status === "running" ||
        (task.status === "blocked" && !isParked(task));
      const sessionId = this.currentSession(task.id);
      const view = sessionId ? this.rm.sessions.get(sessionId) : undefined;
      if (!recoverable && !(mode !== "boot" && view)) continue;
      if (!sessionId || !view) {
        if (mode === "boot" && recoverable) this.markUnknown(now, task, null);
        continue;
      }
      const live = present.get(sessionId);
      if (live) {
        if (mode === "boot" && task.status === "leased" && task.agentId !== null) {
          // createSession returned but session.started/task.started were never recorded
          if (view.state === "requested") {
            this.emit(now, {
              type: "session.started",
              streamId: `session:${sessionId}`,
              sessionId,
              taskId: task.id,
              missionId: task.missionId,
              ...(task.crewId ? { crewId: task.crewId } : {}),
              provenance: "observed",
              source: `runtime:${this.runtimeName}`,
              payload: { runtime: this.runtimeName, runtimeRef: live.runtimeRef },
            });
          }
          this.taskEvent(
            now,
            task,
            { type: "session_started", agentId: task.agentId },
            { agentId: task.agentId, sessionId },
          );
        }
        const current = this.rm.sessions.get(sessionId);
        if (
          current &&
          live.state !== current.state &&
          !TERMINAL_SESSION_STATES.has(current.state)
        ) {
          await this.onRuntimeEvent({
            kind: "session.state_changed",
            sessionId,
            state: live.state,
            observedAt: now.toISOString(),
          });
        } else if (current && mode === "boot" && current.state !== "requested") {
          // same state: re-apply it so a task that missed it (e.g. completed while down) moves on
          await this.onSessionState(
            sessionId,
            current.state,
            current.runtimeStatus ?? undefined,
            now,
          );
        }
        continue;
      }
      if (TERMINAL_SESSION_STATES.has(view.state) || view.lostReason !== null) continue;
      if (view.state === "requested" && mode !== "boot") continue; // createSession still running
      lostIds.push(sessionId);
      const reason = reconciled.lost.includes(sessionId)
        ? "lost while Mimir was not observing"
        : "missing from the runtime";
      this.emit(now, {
        type: "session.lost",
        streamId: `session:${sessionId}`,
        sessionId,
        taskId: task.id,
        missionId: task.missionId,
        provenance: "observed",
        source: `runtime:${this.runtimeName}`,
        payload: { reason },
      });
      if (mode !== "boot") this.onSessionLost(sessionId, `session_lost: ${reason}`, now);
      else if (recoverable) this.markUnknown(now, this.task(task.id), sessionId);
    }
    if (mode === "boot") {
      for (const task of this.rm.tasks.values()) {
        if (task.status === "verifying") this.startVerification(task.id);
      }
    }
    // Nothing to report: no summary (fresh store; a periodic pass that found nothing).
    if (this.rm.sessions.size === 0 && reconciled.sessions.length === 0) return;
    if (mode === "periodic" && lostIds.length === 0) return;
    this.emit(now, {
      type: "recovery.reconciled",
      streamId: "recovery",
      payload: {
        sessions: reconciled.sessions.length,
        lostSessionIds: lostIds as never,
        gap: mode === "gap",
      },
    });
  }

  private markUnknown(now: Date, task: Task, sessionId: string | null): void {
    this.emit(now, {
      type: "recovery.unknown_marked",
      streamId: `task:${task.id}`,
      taskId: task.id,
      missionId: task.missionId,
      ...(sessionId ? { sessionId } : {}),
      payload: { entityType: "task", entityId: task.id, reason: UNKNOWN_AFTER_RESTART },
    });
    this.taskEvent(now, task, { type: "recovery_unknown" });
  }

  private async restoreWorktrees(): Promise<void> {
    const records: PersistedWorktree[] = [];
    for (const worktree of this.rm.worktrees.values()) {
      if (worktree.status === "removed") continue;
      const task = this.rm.tasks.get(worktree.taskId);
      const project = task ? this.projectOf(task) : undefined;
      const baseRef = this.rm.worktreeBaseRefs.get(worktree.id);
      if (project) {
        records.push({
          worktree,
          projectId: project.id,
          repoPath: project.repoPath,
          ...(baseRef !== undefined ? { baseRef } : {}),
        });
      }
    }
    try {
      const { restored, rejected } = await this.git.restore(records);
      if (rejected.length > 0) {
        this.log.warn(
          { restored, persisted: records.length, rejected },
          "not every worktree was restored",
        );
      }
    } catch (err) {
      this.log.error({ err: message(err) }, "worktree restore failed");
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Approvals

  private approvalService(now: Date): ApprovalService {
    const records: ApprovalRecord[] = [...this.rm.approvals.values()].map((approval) => {
      const meta = this.rm.approvalMeta.get(approval.id);
      return {
        approval,
        requestedBy: (meta?.requestedBy as Actor | null) ?? SYSTEM_ACTOR,
        payloadSummary: meta?.payloadSummary ?? approval.action,
      };
    });
    return new ApprovalService({ now: () => now, approvals: records });
  }

  private requestApproval(
    now: Date,
    input: {
      action: PrivilegedAction;
      requestedBy: Actor;
      missionId?: string;
      taskId?: string;
      sessionId?: string;
      /** The action instance this approval covers; it is consumed when the action runs. */
      subject: string;
      summary: string;
    },
  ): Approval {
    const svc = this.approvalService(now);
    const approval = svc.request({
      action: input.action,
      requestedBy: input.requestedBy,
      ...(input.missionId ? { missionId: input.missionId as never } : {}),
      ...(input.taskId ? { taskId: input.taskId as never } : {}),
      payloadSummary: input.summary,
      ttlMs: this.approvalTtlMs,
    });
    for (const ev of svc.takeEvents()) {
      if (ev.type !== "approval.requested") continue;
      this.emit(now, {
        type: "approval.requested",
        streamId: `approval:${approval.id}`,
        ...(input.missionId ? { missionId: input.missionId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        payload: {
          ...ev.payload,
          subject: input.subject,
          requestedBy: { kind: input.requestedBy.kind, id: input.requestedBy.id },
        },
      });
    }
    return approval;
  }

  /** The approval with `status` covering `subject` (approved ones only while unconsumed). */
  private bySubject(subject: string, status: "pending" | "approved"): Approval | undefined {
    return [...this.rm.approvals.values()].find((a) => {
      const meta = this.rm.approvalMeta.get(a.id);
      return (
        a.status === status && meta?.subject === subject && (status === "pending" || !meta.consumed)
      );
    });
  }

  /** Records that an approved approval was used; it never covers another action. */
  private consume(now: Date, approval: Approval): void {
    const subject = this.rm.approvalMeta.get(approval.id)?.subject ?? undefined;
    this.emit(now, {
      type: "approval.consumed",
      streamId: `approval:${approval.id}`,
      ...(approval.taskId ? { taskId: approval.taskId } : {}),
      ...(approval.missionId ? { missionId: approval.missionId } : {}),
      payload: { approvalId: approval.id, ...(subject ? { subject } : {}) },
    });
  }

  /**
   * The policy gate for one action instance. Policy is evaluated first, so a deny rule always
   * wins over an earlier approval (I1). `shell.unclassified` is never allowed without approval
   * (ADR-014). An approved, unconsumed approval for `subject` lets the action run once.
   */
  private gate(
    now: Date,
    action: PrivilegedAction,
    actor: Actor,
    projectId: string | undefined,
    subject: string,
  ): GateResult {
    const decision = evaluate(this.policies, {
      action,
      actor,
      ...(projectId !== undefined ? { projectId } : {}),
      now,
    });
    if (decision.effect === "deny") return { kind: "deny", reason: decision.reason };
    if (decision.effect === "allow" && action !== "shell.unclassified") return { kind: "allow" };
    const approved = this.bySubject(subject, "approved");
    if (approved) return { kind: "approved", approval: approved };
    return { kind: "approval_required", pending: this.bySubject(subject, "pending") };
  }

  private expireApprovals(now: Date): void {
    const svc = this.approvalService(now);
    const expired = svc.expire(now);
    for (const ev of svc.takeEvents()) {
      if (ev.type !== "approval.expired") continue;
      const approval = expired.find((a) => a.id === ev.payload.approvalId);
      this.emit(now, {
        type: "approval.expired",
        streamId: `approval:${ev.payload.approvalId}`,
        ...(approval?.taskId ? { taskId: approval.taskId } : {}),
        ...(approval?.missionId ? { missionId: approval.missionId } : {}),
        payload: ev.payload,
      });
      if (approval) this.onApprovalRefused(now, approval, "approval expired");
    }
  }

  /** Human decision on an approval; on approve the gated action resumes. */
  decide(
    approvalId: string,
    decision: "approved" | "rejected",
    reason?: string,
  ): Promise<Approval> {
    return this.enqueue(async () => {
      const now = this.now();
      const svc = this.approvalService(now);
      const approval = svc.decide(approvalId as never, {
        decision,
        actor: OPERATOR,
        reason: reason ?? decision,
      });
      for (const ev of svc.takeEvents()) {
        if (ev.type !== "approval.decided") continue;
        this.emit(now, {
          type: "approval.decided",
          streamId: `approval:${approvalId}`,
          ...(approval.taskId ? { taskId: approval.taskId } : {}),
          ...(approval.missionId ? { missionId: approval.missionId } : {}),
          provenance: "observed",
          source: "operator",
          payload: ev.payload,
        });
      }
      if (decision === "approved") await this.onApproved(now, approval);
      else this.onApprovalRefused(now, approval, reason ?? "rejected by operator");
      return approval;
    });
  }

  /**
   * Resumes the gated action. Operator actions (trust prompt, force stop, PR) run now and consume
   * the approval once they succeed (a failure leaves it usable by a retried request). Dispatch and
   * verification approvals are consumed when the dispatch or the verification runs.
   */
  private async onApproved(now: Date, approval: Approval): Promise<void> {
    const meta = this.rm.approvalMeta.get(approval.id);
    const sessionId = meta?.sessionId ?? null;
    const subject = meta?.subject ?? "";
    const task = approval.taskId ? this.rm.tasks.get(approval.taskId) : undefined;
    if (
      approval.action === "runtime.accept_trust_prompt" ||
      approval.action === "runtime.force_stop" ||
      approval.action === "pr.create"
    ) {
      const projectId = task
        ? this.projectOf(task)?.id
        : approval.missionId
          ? this.rm.missions.get(approval.missionId)?.projectId
          : undefined;
      const gate = this.gate(now, approval.action, OPERATOR, projectId, subject);
      if (gate.kind === "deny") {
        this.policyDenied(now, approval.action, gate.reason, {
          ...(approval.taskId ? { taskId: approval.taskId } : {}),
          ...(approval.missionId ? { missionId: approval.missionId } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        return;
      }
    }
    switch (approval.action) {
      case "runtime.accept_trust_prompt":
        if (sessionId && this.runtime) {
          await this.runtime.sendInput(sessionId, { keys: [...TRUST_PROMPT_ACCEPT_KEYS] });
          this.recordInput(now, sessionId, `[keys: ${TRUST_PROMPT_ACCEPT_KEYS.join(" ")}]`);
          this.consume(now, approval);
        }
        return;
      case "runtime.force_stop":
        if (sessionId && this.runtime) {
          await this.runtime.requestStop(sessionId, "force");
          this.consume(now, approval);
        }
        return;
      case "pr.create":
        if (task) {
          await this.deliver(now, task);
          this.consume(now, approval);
        }
        return;
      default:
        if (subject.startsWith("verify:")) {
          if (task?.status === "verifying") this.startVerification(task.id);
          return;
        }
        if (task?.status === "blocked" && task.blockedReason === APPROVAL_REQUIRED) {
          this.taskEvent(now, task, { type: "dispatch_approved" });
        }
    }
  }

  private onApprovalRefused(now: Date, approval: Approval, reason: string): void {
    const task = approval.taskId ? this.rm.tasks.get(approval.taskId) : undefined;
    this.policyDenied(now, approval.action, reason, {
      ...(approval.taskId ? { taskId: approval.taskId } : {}),
      ...(approval.missionId ? { missionId: approval.missionId } : {}),
    });
    if (
      task?.status === "verifying" &&
      this.rm.approvalMeta.get(approval.id)?.subject?.startsWith("verify:")
    ) {
      this.taskEvent(now, task, { type: "verification_gated" });
    }
    if (task?.status === "blocked" && task.blockedReason === APPROVAL_REQUIRED) {
      this.taskEvent(now, task, { type: "dispatch_denied" });
    }
  }

  private policyDenied(
    now: Date,
    action: string,
    reason: string,
    ids: { taskId?: string; missionId?: string; sessionId?: string },
  ): void {
    this.emit(now, {
      type: "policy.denied",
      streamId: ids.taskId ? `task:${ids.taskId}` : "policy",
      ...ids,
      payload: { action, reason },
    });
  }

  /**
   * A privileged operator action (force stop, PR) for one action instance (`subject`): policy
   * first (deny wins), then an approved unconsumed approval for that subject runs it and is
   * consumed; otherwise the pending approval is returned or a new one requested.
   */
  private async gated(
    now: Date,
    action: PrivilegedAction,
    where: { taskId?: string; sessionId?: string; missionId?: string },
    subject: string,
    summary: string,
    run: () => Promise<void>,
  ): Promise<GatedOutcome> {
    const projectId = where.taskId
      ? this.projectOf(this.task(where.taskId))?.id
      : where.missionId
        ? this.rm.missions.get(where.missionId)?.projectId
        : undefined;
    const gate = this.gate(now, action, OPERATOR, projectId, subject);
    if (gate.kind === "deny") {
      this.policyDenied(now, action, gate.reason, where);
      return { kind: "denied", reason: gate.reason };
    }
    if (gate.kind === "approval_required") {
      const approval =
        gate.pending ??
        this.requestApproval(now, {
          action,
          requestedBy: SYSTEM_ACTOR,
          subject,
          summary,
          ...where,
        });
      return { kind: "approval_required", approval };
    }
    await run();
    if (gate.kind === "approved") this.consume(now, gate.approval);
    return { kind: "done" };
  }

  // ---------------------------------------------------------------------------------------------
  // Operator commands (routes)

  startMission(missionId: string): Promise<Mission> {
    return this.enqueue(() => {
      const mission = this.mission(missionId);
      const now = this.now();
      return this.missionEvent(now, mission, { type: "start" });
    });
  }

  pauseMission(missionId: string): Promise<Mission> {
    return this.enqueue(() =>
      this.missionEvent(this.now(), this.mission(missionId), { type: "pause" }),
    );
  }

  resumeMission(missionId: string): Promise<Mission> {
    return this.enqueue(() =>
      this.missionEvent(this.now(), this.mission(missionId), { type: "resume" }),
    );
  }

  /** Cancels the mission, its unfinished tasks, and asks their live sessions to stop. */
  cancelMission(missionId: string, reason?: string): Promise<Mission> {
    return this.enqueue(() => {
      const now = this.now();
      const next = this.missionEvent(now, this.mission(missionId), {
        type: "cancel",
        ...(reason !== undefined ? { reason } : {}),
      });
      for (const task of [...this.rm.tasks.values()]) {
        if (task.missionId !== missionId || !taskMachine.can(task, "cancel")) continue;
        this.verifications.get(task.id)?.abort();
        const sessionId = this.currentSession(task.id);
        this.taskEvent(now, task, { type: "cancel" }, { cancelReason: "mission cancelled" });
        const session = sessionId ? this.rm.sessions.get(sessionId) : undefined;
        if (sessionId && session && LIVE_SESSION_STATES.has(session.state) && this.runtime) {
          void this.runtime
            .requestStop(sessionId, "soft")
            .catch((err: unknown) =>
              this.log.warn({ sessionId, err: message(err) }, "stop on cancel failed"),
            );
        }
      }
      return next;
    });
  }

  /** Re-run checks on a settled worktree without launching an agent or rewriting delivery history. */
  async recheckVerification(
    taskId: string,
  ): Promise<{ artifactId: string; passed: boolean; semantics: string }> {
    if (this.verifications.has(taskId))
      throw new MimirError("conflict", "verification is already running");
    const ac = new AbortController();
    this.verifications.set(taskId, ac);
    try {
      const input = await this.enqueue(async () => {
        const task = this.task(taskId);
        if (!["completed", "failed"].includes(task.status))
          throw new MimirError(
            "invalid_transition",
            "recheck requires a settled task; active work cannot be checked concurrently",
          );
        const worktree = this.activeWorktree(taskId);
        if (!worktree) throw new MimirError("not_found", "task worktree is unavailable");
        const project = this.projectOf(task);
        const testCommand = testCommandOf(project);
        const verifierConfig = task.verification ?? projectSettings(project).verification;
        const action =
          verifierConfig !== undefined
            ? null
            : classifyCommand(
                testCommand,
                classifyOptions(project, worktree.path, worktree.branch),
              );
        if (action !== null) {
          const subject = `recheck:${task.id}:${task.version}:${argvDigest(testCommand)}`;
          const gate = this.gate(this.now(), action, SYSTEM_ACTOR, project?.id, subject);
          if (gate.kind === "deny") throw new MimirError("policy_denied", gate.reason);
          if (gate.kind === "approval_required") {
            if (!gate.pending)
              this.requestApproval(this.now(), {
                action,
                requestedBy: SYSTEM_ACTOR,
                missionId: task.missionId,
                taskId: task.id,
                subject,
                summary: `Recheck verification for ${task.title}`,
              });
            throw new MimirError("policy_denied", "verification recheck requires command approval");
          }
          if (gate.kind === "approved") this.consume(this.now(), gate.approval);
        }
        const manifest = this.git.has(worktree.id)
          ? await this.git.changedFilesManifest(worktree.id)
          : null;
        return {
          taskId,
          taskTitle: task.title,
          missionId: task.missionId,
          worktreePath: worktree.path,
          baseRef: worktree.baseSha,
          headSha: manifest?.headSha ?? null,
          testCommand,
          ...(verifierConfig !== undefined ? { verifierConfig } : {}),
        };
      });
      const result = await this.verifier.verify({ ...input, signal: ac.signal });
      if (ac.signal.aborted) throw new MimirError("conflict", "recheck interrupted");
      return await this.enqueue(() => {
        const artifactId = this.recordArtifact(
          this.now(),
          this.task(taskId),
          "file",
          JSON.stringify({
            kind: "operator-verification-recheck",
            checkedAt: this.now().toISOString(),
            binding: input,
            result,
          }),
        );
        return {
          artifactId,
          passed: result.passed,
          semantics:
            "Fresh check evidence only. Existing task acceptance and delivery history are unchanged; revise and execute a plan to accept changed code.",
        };
      });
    } finally {
      if (this.verifications.get(taskId) === ac) this.verifications.delete(taskId);
    }
  }

  retryTask(taskId: string): Promise<Task> {
    return this.enqueue(() => this.taskEvent(this.now(), this.task(taskId), { type: "retry" }));
  }

  /** Sends operator text to a session; recorded as an observed `session.input`. */
  sendInput(sessionId: string, text: string): Promise<void> {
    return this.enqueue(async () => {
      this.session(sessionId);
      const runtime = this.requireRuntime();
      await runtime.sendInput(sessionId, { text });
      this.recordInput(this.now(), sessionId, text);
    });
  }

  private recordInput(now: Date, sessionId: string, text: string): void {
    const view = this.rm.sessions.get(sessionId);
    const r = redact(text);
    this.emit(now, {
      type: "session.input",
      streamId: `session:${sessionId}`,
      sessionId,
      ...(view?.taskId ? { taskId: view.taskId } : {}),
      ...this.missionOf(view?.taskId ?? null),
      provenance: "observed",
      source: "operator",
      payload: { text: r.text, redacted: r.redacted },
    });
  }

  /**
   * Soft stop runs directly; when the runtime cannot confirm it (retryable conflict) a
   * `runtime.force_stop` approval is requested. Force stop always needs that approval.
   */
  stopSession(sessionId: string, mode: "soft" | "force"): Promise<GatedOutcome> {
    return this.enqueue(async () => {
      const view = this.session(sessionId);
      const runtime = this.requireRuntime();
      const now = this.now();
      const where = {
        sessionId,
        ...(view.taskId ? { taskId: view.taskId } : {}),
        ...this.missionOf(view.taskId),
      };
      const summary = `force stop session ${sessionId}${view.taskId ? ` (task ${view.taskId})` : ""}`;
      if (mode === "force") {
        return this.gated(now, "runtime.force_stop", where, `stop:${sessionId}`, summary, () =>
          runtime.requestStop(sessionId, "force"),
        );
      }
      try {
        await runtime.requestStop(sessionId, "soft");
        return { kind: "done" } as const;
      } catch (err) {
        const details = isMimirError(err)
          ? (err.details as { retryable?: boolean } | undefined)
          : undefined;
        if (!isMimirError(err) || err.code !== "conflict" || details?.retryable !== true) throw err;
        // escalate: a force stop with approval
        return this.gated(
          now,
          "runtime.force_stop",
          where,
          `stop:${sessionId}`,
          `${summary}: soft stop unconfirmed`,
          () => runtime.requestStop(sessionId, "force"),
        );
      }
    });
  }

  /** `POST /v1/tasks/:id/pr`: needs a `pr.create` approval; never pushes or merges. */
  requestPr(taskId: string): Promise<GatedOutcome> {
    return this.enqueue(async () => {
      const task = this.task(taskId);
      if (task.status !== "completed") {
        throw new MimirError("invalid_transition", "only a completed task can be delivered", {
          taskId,
          status: task.status,
        });
      }
      if (!this.activeWorktree(taskId)) {
        throw new MimirError("conflict", "task has no worktree to deliver", { taskId });
      }
      const now = this.now();
      return this.gated(
        now,
        "pr.create",
        { taskId, missionId: task.missionId },
        `pr:${taskId}`,
        `deliver verified results for task "${task.title}"`,
        () => this.deliver(now, task),
      );
    });
  }

  private async deliver(now: Date, task: Task): Promise<void> {
    const worktree = this.activeWorktree(task.id);
    const project = this.projectOf(task);
    if (!worktree || !project) throw new MimirError("conflict", "task has no worktree to deliver");
    if (await this.pr.available(project.repoPath)) {
      const out = await this.pr.create({
        repoPath: project.repoPath,
        worktreePath: worktree.path,
        branch: worktree.branch,
        title: task.title,
        body: task.acceptance === "" ? task.title : task.acceptance,
      });
      this.recordArtifact(now, task, "pr.created", out.output);
      return;
    }
    const tasks = [...this.rm.tasks.values()].filter((t) => t.missionId === task.missionId);
    if (tasks.some((t) => t.status !== "completed" || !t.resultCommit))
      throw new MimirError(
        "conflict",
        "local delivery requires every mission task to have a verified result",
      );
    const dependentIds = new Set([...this.rm.taskDependencies.values()].map((d) => d.taskId));
    const roots = tasks
      .filter((t) => !dependentIds.has(t.id))
      .map((t) => this.activeWorktree(t.id)?.baseSha);
    if (roots.some((sha) => !sha))
      throw new MimirError("conflict", "local delivery is missing its original base");
    const result = await this.git.exportResult(
      project.id,
      project.repoPath,
      roots as string[],
      tasks.map((t) => t.resultCommit!),
    );
    this.recordArtifact(
      now,
      task,
      "local_delivery",
      JSON.stringify(
        {
          ...result,
          repoPath: project.repoPath,
          taskIds: tasks.map((t) => t.id),
          format: "git-patch",
          apply: "git apply --check result.patch && git apply result.patch",
          undo: "git apply --reverse --check result.patch && git apply --reverse result.patch",
        },
        null,
        2,
      ),
    );
  }

  // ---------------------------------------------------------------------------------------------
  // Budgets

  private checkBudgets(now: Date): void {
    const usage = [...this.rm.usageSamples.values()];
    const attribution = {
      agents: [...this.rm.agents.values()].map((a) => ({ id: a.id, crewId: a.crewId })),
      crews: [...this.rm.crews.values()],
    };
    for (const budget of this.rm.budgets.values()) {
      const r = budgetGuard.evaluate(toBudgetPolicy(budget), usage, attribution);
      const unit = budget.limitTokens !== null ? ("tokens" as const) : ("cost" as const);
      const limit = unit === "tokens" ? budget.limitTokens : budget.limitCost;
      if (limit === null) continue;
      const used = unit === "tokens" ? r.spentTokens : r.spentCost;
      const ids = {
        ...(budget.missionId ? { missionId: budget.missionId } : {}),
        ...(budget.crewId ? { crewId: budget.crewId } : {}),
      };
      // An exhausted budget reports budget.exceeded instead of a warning.
      if (r.warn && !r.exhausted) {
        this.emit(now, {
          type: "budget.warning",
          streamId: `budget:${budget.id}`,
          ...ids,
          sourceEventId: `budget.warning:${budget.id}`,
          payload: { budgetId: budget.id, unit, used, limit },
        });
      }
      if (r.exhausted) {
        this.emit(now, {
          type: "budget.exceeded",
          streamId: `budget:${budget.id}`,
          ...ids,
          sourceEventId: `budget.exceeded:${budget.id}`,
          payload: { budgetId: budget.id, unit, used, limit },
        });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers

  /** Appends an event (event first; the read model follows via subscribe). */
  private emit<T extends EventType>(now: Date, input: EmitInput<T>): void {
    emit(this.store, now, input);
  }

  private taskEvent(now: Date, task: Task, event: TaskEvent, ctx: TaskEventContext = {}): Task {
    const { emit: e } = taskTransition(task, event, ctx);
    emit(this.store, now, e);
    return this.task(task.id);
  }

  private missionEvent(
    now: Date,
    mission: Mission,
    event: Parameters<typeof missionTransition>[1],
  ): Mission {
    const { emit: e } = missionTransition(mission, event);
    emit(this.store, now, e);
    return this.mission(mission.id);
  }

  /** The latest session requested for a task (Map insertion order = request order). */
  currentSession(taskId: string): string | undefined {
    let last: string | undefined;
    for (const s of this.rm.sessions.values()) if (s.taskId === taskId) last = s.id;
    return last;
  }

  private missionOf(taskId: string | null): { missionId?: string } {
    const missionId = taskId ? this.rm.tasks.get(taskId)?.missionId : undefined;
    return missionId ? { missionId } : {};
  }

  private projectOf(task: Task): Project | undefined {
    const mission = this.rm.missions.get(task.missionId);
    return mission ? this.rm.projects.get(mission.projectId) : undefined;
  }

  private task(id: string): Task {
    const t = this.rm.tasks.get(id);
    if (!t) throw new MimirError("not_found", `task ${id} not found`, { taskId: id });
    return t;
  }

  private mission(id: string): Mission {
    const m = this.rm.missions.get(id);
    if (!m) throw new MimirError("not_found", `mission ${id} not found`, { missionId: id });
    return m;
  }

  private session(id: string) {
    const s = this.rm.sessions.get(id);
    if (!s) throw new MimirError("not_found", `session ${id} not found`, { sessionId: id });
    return s;
  }

  private requireRuntime(): RuntimeAdapter {
    if (!this.runtime) throw new MimirError("runtime_unavailable", "no runtime is configured");
    return this.runtime;
  }
}
