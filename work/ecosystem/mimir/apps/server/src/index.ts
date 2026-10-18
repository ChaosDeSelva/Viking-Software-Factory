import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AuditLog, CommandLedger, EventStore, PolicyRule } from "@mimir/core";
import { GitManager } from "@mimir/git";
import type { RuntimeAdapter } from "@mimir/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { Logger } from "pino";
import { registerSecurity } from "./auth.js";
import { registerBodyDepthGuard } from "./body-depth.js";
import { DEFAULT_ALLOWED_ORIGINS } from "./config.js";
import type { ServerContext } from "./context.js";
import { registerErrorHandling } from "./errors.js";
import { failInterruptedCommands, registerIdempotencyGuard } from "./idempotency.js";
import { migrateLegacyProjects } from "./legacy-projects.js";
import { ReadModel } from "./readmodel.js";
import { registerStatic } from "./static.js";
import { SupervisorStore } from "./supervision/store.js";
import { CliThinker, MissionBrain } from "./supervision/brain.js";
import { SupervisorEngine } from "./supervision/engine.js";
import { supervisorRoutes } from "./routes/supervisors.js";
import { fleetRoutes } from "./routes/fleet.js";
import { capabilitiesRoutes } from "./routes/capabilities.js";
import { DEFAULT_SSE_DROP_GRACE_MS, eventRoutes } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { projectRoutes } from "./routes/projects.js";
import { snapshotRoutes } from "./routes/snapshot.js";
import { approvalRoutes } from "./routes/approvals.js";
import { artifactRoutes } from "./routes/artifacts.js";
import {
  DEFAULT_BLOCKED_THRESHOLD_MS,
  DEFAULT_STUCK_THRESHOLD_MS,
  attentionRoutes,
} from "./routes/attention.js";
import { crewRoutes } from "./routes/crews.js";
import { missionRoutes } from "./routes/missions.js";
import { sessionRoutes } from "./routes/sessions.js";
import { taskRoutes } from "./routes/tasks.js";
import { usageRoutes } from "./routes/usage.js";
import { ArtifactStore, DEFAULT_ARTIFACT_RETENTION_DAYS } from "./orchestrator/artifacts.js";
import { GitWorktreePort, type WorktreePort } from "./orchestrator/git-port.js";
import {
  DEFAULT_TICK_MS,
  Orchestrator,
  type OrchestratorLogger,
} from "./orchestrator/orchestrator.js";
import { DEFAULT_SERVER_POLICIES } from "./orchestrator/policy.js";
import { LocalDeliveryRunner, type PrRunner } from "./orchestrator/pr.js";
import { TestCommandVerifier, type Verifier } from "./orchestrator/verifier.js";

export const PACKAGE_NAME = "@mimir/server";
export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const DEFAULT_SSE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export interface BuildServerOptions {
  store: EventStore;
  ledger: CommandLedger;
  audit: AuditLog;
  runtime: RuntimeAdapter | null;
  authToken: string;
  /** pino logger (see `createLogger`); logging is off when omitted. */
  logger?: Logger;
  /**
   * Origins this server is reached at (e.g. `http://127.0.0.1:7700`), used for Host and Origin
   * checks. Loopback names at the bound port are added automatically when listening on loopback.
   */
  publicOrigins?: readonly string[];
  /** CSRF allowlist in addition to the server's own origins. Defaults to the web dev server. */
  allowedOrigins?: readonly string[];
  /** When non-empty, project repo paths must resolve inside one of these. */
  allowedRoots?: readonly string[];
  /** PEM cert/key; serves HTTPS when given. */
  https?: { cert: string | Buffer; key: string | Buffer };
  sseHeartbeatMs?: number;
  /** Unsent bytes allowed per SSE client before it is dropped with `event: gap`. */
  sseMaxBufferBytes?: number;
  /** Events read per page while replaying an SSE client's backlog. */
  sseReplayPageSize?: number;
  /** How long a dropped slow SSE consumer may take to flush before its socket is destroyed. */
  sseDropGraceMs?: number;
  /** Server clock; defaults to the system clock. */
  now?: () => Date;
  /** Holds `artifacts/` and (by default) `worktrees/`. A temp dir when omitted. */
  dataDir?: string;
  /** Orchestrator tick interval; 0 = no loop (call `app.mimir.orchestrator.tick()`). */
  tickMs?: number;
  /** Worktree manager; defaults to `GitManager` rooted at `worktreeRoot`. */
  git?: WorktreePort;
  /**
   * Root for agent worktrees (config `MIMIR_WORKTREE_ROOT`). Must be outside `dataDir`, which
   * holds the operator token (audit H1). Default: `<dataDir>-worktrees`, a sibling.
   */
  worktreeRoot?: string;
  /** Verification for the `verifying` step; defaults to `TestCommandVerifier`. */
  verifier?: Verifier;
  /** Extra policy rules on top of `DEFAULT_SERVER_POLICIES`. */
  policies?: readonly PolicyRule[];
  approvalTtlMs?: number;
  prRunner?: PrRunner;
  /** `MIMIR_ARTIFACT_RETENTION_DAYS` (default 30); pruned at boot and daily. */
  artifactRetentionDays?: number;
  attention?: { blockedMs?: number; stuckMs?: number };
  /** Largest artifact served by `GET /v1/artifacts/:id/content` (`MIMIR_MAX_ARTIFACT_BYTES`). */
  maxArtifactBytes?: number;
  /** Built web app directory (`apps/web/dist`); served from the same origin when set. */
  webRoot?: string;
  /** Ticks between periodic runtime reconciles (`MIMIR_RECONCILE_EVERY_TICKS`, default 30). */
  reconcileEveryTicks?: number;
  /** Set when the runtime adapter reports measured usage (the local CLI adapter does). */
  runtimeReportsUsage?: boolean;
}

/** The worktree root for a data dir: `explicit` when given, else a sibling; never inside it. */
export function serverWorktreeRoot(dataDir: string, explicit?: string): string {
  const data = resolve(dataDir);
  const root = resolve(explicit ?? `${data}-worktrees`);
  const rel = relative(data, root);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(
      `worktree root ${root} must not be inside the data dir ${data}: it holds the operator token`,
    );
  }
  return root;
}

export function buildServer(opts: BuildServerOptions): FastifyInstance {
  if (opts.authToken.length === 0) throw new Error("buildServer: authToken must not be empty");
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    ...(opts.https ? { https: opts.https } : {}),
  }) as unknown as FastifyInstance;

  const readModel = ReadModel.load(opts.store, {
    onSkip: (event, reason) =>
      app.log.debug({ eventId: event.id, type: event.type, reason }, "read model skipped event"),
  });
  failInterruptedCommands(opts);
  const now = opts.now ?? (() => new Date());
  migrateLegacyProjects(opts.store, readModel, now());

  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "mimir-data-"));
  const worktreeRoot = serverWorktreeRoot(dataDir, opts.worktreeRoot);
  const artifacts = new ArtifactStore(join(dataDir, "artifacts"));
  const log: OrchestratorLogger = {
    info: (o, m) => app.log.info(o, m),
    warn: (o, m) => app.log.warn(o, m),
    error: (o, m) => app.log.error(o, m),
  };
  const orchestrator = new Orchestrator({
    store: opts.store,
    readModel,
    runtime: opts.runtime,
    git:
      opts.git ??
      new GitWorktreePort(new GitManager({ worktreeRoot, dataDirs: [resolve(dataDir)] })),
    verifier: opts.verifier ?? new TestCommandVerifier(),
    artifacts,
    policies: [...DEFAULT_SERVER_POLICIES, ...(opts.policies ?? [])],
    now,
    pr: opts.prRunner ?? new LocalDeliveryRunner(),
    tickMs: opts.tickMs ?? DEFAULT_TICK_MS,
    log,
    ...(opts.approvalTtlMs !== undefined ? { approvalTtlMs: opts.approvalTtlMs } : {}),
    ...(opts.reconcileEveryTicks !== undefined
      ? { reconcileEveryTicks: opts.reconcileEveryTicks }
      : {}),
  });
  const retentionDays = opts.artifactRetentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS;
  const pruneArtifacts = () => {
    const removed = artifacts.prune(now(), retentionDays);
    if (removed.length > 0) app.log.info({ removed: removed.length }, "pruned artifacts");
  };
  let pruneTimer: ReturnType<typeof setInterval> | null = null;

  const ctx: ServerContext = {
    store: opts.store,
    ledger: opts.ledger,
    audit: opts.audit,
    runtime: opts.runtime,
    readModel,
    now,
    orchestrator,
    runtimeReportsUsage: opts.runtimeReportsUsage ?? false,
    artifacts,
    allowedRoots: opts.allowedRoots ?? [],
    sse: {
      heartbeatMs: opts.sseHeartbeatMs ?? DEFAULT_SSE_HEARTBEAT_MS,
      maxBufferBytes: opts.sseMaxBufferBytes ?? DEFAULT_SSE_MAX_BUFFER_BYTES,
      replayPageSize: opts.sseReplayPageSize ?? 500,
      dropGraceMs: opts.sseDropGraceMs ?? DEFAULT_SSE_DROP_GRACE_MS,
    },
  };
  app.decorate("mimir", ctx);
  const supervisors = new SupervisorStore(join(dataDir, "supervisors.sqlite"));
  const thinker = new CliThinker(dataDir);
  const brain = new MissionBrain(
    supervisors,
    (id) => {
      const mission = readModel.missions.get(id);
      if (!mission) return null;
      const tasks = [...readModel.tasks.values()].filter((t) => t.missionId === id);
      const taskIds = new Set<string>(tasks.map((t) => t.id));
      const sessions = [...readModel.sessions.values()].filter(
        (s) => s.taskId && taskIds.has(s.taskId),
      );
      return { mission, tasks, sessions, sessionIds: sessions.map((s) => s.id) };
    },
    thinker.think,
  );
  const supervisorEngine = new SupervisorEngine(supervisors, async (message, lease) => {
    if (message.kind === "think") return brain.execute(message, lease);
    const control = JSON.parse(message.body) as {
      sessionId: string;
      text: string;
      mode: "soft" | "force";
    };
    if (message.kind === "observe")
      return JSON.stringify(
        (await opts.runtime?.getSession(control.sessionId)) ?? { state: "unknown" },
      );
    if (message.kind === "input") {
      await orchestrator.sendInput(control.sessionId, control.text);
      return "Instruction delivered";
    }
    if (message.kind === "stop")
      return JSON.stringify(await orchestrator.stopSession(control.sessionId, control.mode));
    throw new Error("Unsupported supervisor control");
  });
  // Recovery runs before the server accepts requests (onReady), then the tick loop starts.
  app.addHook("onReady", async () => {
    pruneArtifacts();
    pruneTimer = setInterval(pruneArtifacts, 24 * 60 * 60 * 1000);
    pruneTimer.unref();
    await orchestrator.start();
    supervisorEngine.start();
  });
  app.addHook("onClose", async () => {
    if (pruneTimer) clearInterval(pruneTimer);
    const stopped = supervisorEngine.stop();
    await thinker.close();
    await stopped;
    supervisors.close();
    await orchestrator.stop();
    readModel.detach();
  });

  registerErrorHandling(app);
  registerSecurity(app, {
    authToken: opts.authToken,
    allowedOrigins: opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
    publicOrigins: opts.publicOrigins ?? [],
    tls: opts.https !== undefined,
  });
  registerIdempotencyGuard(app);
  fleetRoutes(app);
  supervisorRoutes(app, supervisors);
  registerBodyDepthGuard(app);

  healthRoutes(app);
  capabilitiesRoutes(app);
  eventRoutes(app);
  snapshotRoutes(app);
  projectRoutes(app);
  missionRoutes(app);
  crewRoutes(app);
  taskRoutes(app);
  approvalRoutes(app);
  sessionRoutes(app);
  artifactRoutes(app, opts.maxArtifactBytes);
  usageRoutes(app);
  attentionRoutes(app, {
    blockedMs: opts.attention?.blockedMs ?? DEFAULT_BLOCKED_THRESHOLD_MS,
    stuckMs: opts.attention?.stuckMs ?? DEFAULT_STUCK_THRESHOLD_MS,
  });
  if (opts.webRoot !== undefined) registerStatic(app, opts.webRoot);
  return app;
}

export type { ServerContext } from "./context.js";
export { createLogger } from "./logger.js";
export {
  failInterruptedCommands,
  idempotent,
  IDEMPOTENCY_REPLAYED_HEADER,
  OPERATOR_ACTOR,
  type CommandResult,
} from "./idempotency.js";
export { parseWith, toMimirError } from "./errors.js";
export { ReadModel, deterministicId, type SessionView } from "./readmodel.js";
export { migrateLegacyProjects } from "./legacy-projects.js";
export { emit, SERVER_SOURCE, type EmitInput } from "./emit.js";
export {
  DEFAULT_TICK_MS,
  Orchestrator,
  TRUST_PROMPT_ACCEPT_KEYS,
  type GatedOutcome,
  type OrchestratorOptions,
} from "./orchestrator/orchestrator.js";
export { ArtifactStore, DEFAULT_ARTIFACT_RETENTION_DAYS } from "./orchestrator/artifacts.js";
export {
  GitWorktreePort,
  type PersistedWorktree,
  type WorktreePort,
} from "./orchestrator/git-port.js";
export { DEFAULT_SERVER_POLICIES } from "./orchestrator/policy.js";
export { GhPrRunner, type PrRequest, type PrRunner } from "./orchestrator/pr.js";
export { BrokkrVerifier } from "@mimir/brokkr-verifier";
export { RoutingVerifier, selectVerifier } from "./orchestrator/verifier-select.js";
export {
  TestCommandVerifier,
  type VerificationCheck,
  type VerificationResult,
  type Verifier,
  type VerifyInput,
} from "./orchestrator/verifier.js";
export { AGENT_ARGV_TEMPLATES, ROLE_TEMPLATES, argvFor, briefFor } from "./templates.js";
export { checkCursor, type EventsPage } from "./routes/events.js";
export {
  DEFAULT_ALLOWED_ORIGINS,
  ensureAuthToken,
  isLoopbackHost,
  loadConfig,
  resolveListenOptions,
  type ServerConfig,
} from "./config.js";
