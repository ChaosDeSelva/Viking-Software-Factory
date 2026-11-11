import { z } from "zod";
import {
  ApprovalStatusSchema,
  CommandStatusSchema,
  CrewRoleSchema,
  CrewStatusSchema,
  MissionStatusSchema,
  RuntimeSessionStateSchema,
  TaskStatusSchema,
  UsageSourceSchema,
} from "./enums.js";
import {
  AgentIdSchema,
  ApprovalIdSchema,
  ArtifactIdSchema,
  AuditEntryIdSchema,
  BudgetIdSchema,
  CommandIdSchema,
  CrewIdSchema,
  CrewMemberIdSchema,
  GitShaSchema,
  MissionIdSchema,
  OperationIdSchema,
  PolicyIdSchema,
  ProjectIdSchema,
  SessionIdSchema,
  TaskDependencyIdSchema,
  TaskIdSchema,
  TimestampSchema,
  UsageSampleIdSchema,
  WorktreeIdSchema,
} from "./ids.js";

/** Fields every persisted entity carries. `version` increments on each change (optimistic concurrency). */
function entity<I extends z.ZodType, S extends z.ZodRawShape>(id: I, shape: S) {
  return z.object({
    id,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    version: z.number().int().min(0),
    ...shape,
  });
}

/** An exact-allowlist entry (core `AllowlistEntry`, ADR-014). `argv0` is compared exactly. */
export const AllowlistEntrySchema = z.object({
  argv0: z.string().min(1),
  args: z.union([
    z.literal("none"),
    z.object({ exact: z.array(z.string()) }),
    z.object({
      shape: z.object({
        prefix: z.array(z.string()).optional(),
        maxArgs: z.number().int().min(0),
        allowFlags: z.array(z.string()).optional(),
        numericFlags: z.boolean().optional(),
        forbidFlags: z.array(z.string()).optional(),
        forbidChars: z.string().optional(),
        pathArgsMustBeInsideWorktreeAndNonSensitive: z.boolean(),
      }),
    }),
  ]),
});
export type AllowlistEntryInput = z.infer<typeof AllowlistEntrySchema>;

/** Environment variable names a project may not set: they would defeat the launch hardening. */
const RESERVED_ENV_NAME = /^(?:GIT_.*|LD_.*|DYLD_.*|MIMIR_.*|NODE_OPTIONS|BASH_ENV|ENV|HOME|PATH)$/;

const EnvNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name")
  .refine((name) => !RESERVED_ENV_NAME.test(name), "this variable cannot be set by a project");

const hasControlChar = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

const AbsolutePathSchema = z
  .string()
  .max(1024)
  .refine((path) => path.startsWith("/") && !hasControlChar(path), "expected an absolute path")
  .refine((path) => !path.split("/").includes(".."), "must not contain '..' segments");

/**
 * What a project's agent sessions and verification runs get on top of the allowlisted
 * environment. Operator configuration: only the projects API writes it.
 */
export const ProjectAgentSettingsSchema = z.strictObject({
  env: z
    .record(
      EnvNameSchema,
      z
        .string()
        .max(4096)
        .refine((value) => !value.includes("\0"), "must not contain NUL"),
    )
    .refine((env) => Object.keys(env).length <= 64, "at most 64 variables")
    .optional(),
  /** Absolute directories put in front of PATH, in this order. */
  pathPrepend: z
    .array(AbsolutePathSchema.refine((p) => !p.includes(":"), "must not contain ':'"))
    .max(32)
    .optional(),
  /** Codex `workspace-write` sandbox additions for this project's tasks. */
  codexSandbox: z
    .strictObject({
      writableRoots: z.array(AbsolutePathSchema).max(32).optional(),
      networkAccess: z.boolean().optional(),
    })
    .optional(),
});
export type ProjectAgentSettings = z.infer<typeof ProjectAgentSettingsSchema>;

/**
 * Known project settings (other keys pass through). `testCommand` is an argv array (no implicit
 * shell); `allowedCommands` replaces the default exact allowlist for this project's commands.
 */
export const ProjectSettingsSchema = z.looseObject({
  testCommand: z.array(z.string().min(1)).min(1).optional(),
  allowedCommands: z.array(AllowlistEntrySchema).optional(),
  protectedBranches: z.array(z.string().min(1)).optional(),
  harnessRef: z.string().min(1).optional(),
  /**
   * Verifier configuration, passed to the configured verifier unread (Mimir does not interpret
   * it). With Brokkr: `{ harnesses, lockPath, policyPath? }` (see docs/verification.md).
   */
  verification: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  agent: ProjectAgentSettingsSchema.optional(),
  /** Time limit of one test-command verification run (default 10 minutes). */
  verificationTimeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSchema = entity(ProjectIdSchema, {
  name: z.string().min(1),
  repoPath: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
}).meta({ id: "Project" });
export type Project = z.infer<typeof ProjectSchema>;

export const MissionSchema = entity(MissionIdSchema, {
  projectId: ProjectIdSchema,
  objective: z.string().min(1),
  status: MissionStatusSchema,
  /** See `CreateMissionRequest.baseCommits`. Absent when work starts from the default branch. */
  baseCommits: z.array(GitShaSchema).optional(),
}).meta({ id: "Mission" });
export type Mission = z.infer<typeof MissionSchema>;

export const CrewLimitsSchema = z.object({
  maxAgents: z.number().int().min(1).optional(),
  maxConcurrentTasks: z.number().int().min(1).optional(),
  maxAttemptsPerTask: z.number().int().min(1).optional(),
  leaseSeconds: z.number().int().min(1).optional(),
});
export type CrewLimits = z.infer<typeof CrewLimitsSchema>;

export const CrewSchema = entity(CrewIdSchema, {
  schedulingPaused: z.boolean().optional(),
  missionId: MissionIdSchema,
  template: z.string().min(1),
  status: CrewStatusSchema,
  limits: CrewLimitsSchema,
}).meta({ id: "Crew" });
export type Crew = z.infer<typeof CrewSchema>;

export const CrewMemberSchema = entity(CrewMemberIdSchema, {
  crewId: CrewIdSchema,
  role: CrewRoleSchema,
  agentKind: z.string().min(1),
  name: z.string().min(1),
}).meta({ id: "CrewMember" });
export type CrewMember = z.infer<typeof CrewMemberSchema>;

export const TaskSchema = entity(TaskIdSchema, {
  priority: z.number().int().min(0).max(100).optional(),
  resultCommit: GitShaSchema.optional(),
  verification: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  missionId: MissionIdSchema,
  crewId: CrewIdSchema.nullable(),
  title: z.string().min(1),
  acceptance: z.string(),
  status: TaskStatusSchema,
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  agentId: AgentIdSchema.nullable(),
  leaseExpiresAt: TimestampSchema.nullable(),
  /** Why a `blocked` task is blocked (e.g. `budget_exceeded`, or the runtime/approval reason). Absent otherwise. */
  blockedReason: z.string().min(1).optional(),
}).meta({ id: "Task" });
export type Task = z.infer<typeof TaskSchema>;

export const TaskDependencySchema = entity(TaskDependencyIdSchema, {
  taskId: TaskIdSchema,
  dependsOnId: TaskIdSchema,
}).meta({ id: "TaskDependency" });
export type TaskDependency = z.infer<typeof TaskDependencySchema>;

export const AgentSchema = entity(AgentIdSchema, {
  crewId: CrewIdSchema,
  role: CrewRoleSchema,
  agentKind: z.string().min(1),
  runtimeSessionId: SessionIdSchema.nullable(),
  status: RuntimeSessionStateSchema,
  taskId: TaskIdSchema.nullable(),
}).meta({ id: "Agent" });
export type Agent = z.infer<typeof AgentSchema>;

export const WorktreeStatusSchema = z.enum(["active", "conflicted", "removed"]);
export type WorktreeStatus = z.infer<typeof WorktreeStatusSchema>;

export const WorktreeSchema = entity(WorktreeIdSchema, {
  taskId: TaskIdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  baseSha: GitShaSchema,
  status: WorktreeStatusSchema,
}).meta({ id: "Worktree" });
export type Worktree = z.infer<typeof WorktreeSchema>;

export const CommandSchema = entity(CommandIdSchema, {
  idempotencyKey: z.string().min(1),
  type: z.string().min(1),
  status: CommandStatusSchema,
  payload: z.unknown(),
  /** Hash of the request; a replay with the same key and a different hash is `idempotency_replay_mismatch`. */
  requestHash: z.string().min(1),
  operationId: OperationIdSchema,
}).meta({ id: "Command" });
export type Command = z.infer<typeof CommandSchema>;

export const ArtifactSchema = entity(ArtifactIdSchema, {
  taskId: TaskIdSchema,
  kind: z.string().min(1),
  uri: z.string().min(1),
  hash: z.string().min(1),
}).meta({ id: "Artifact" });
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalSchema = entity(ApprovalIdSchema, {
  action: z.string().min(1),
  status: ApprovalStatusSchema,
  actor: z.string().nullable(),
  expiry: TimestampSchema.nullable(),
  missionId: MissionIdSchema.nullable(),
  taskId: TaskIdSchema.nullable(),
  reason: z.string().nullable(),
}).meta({ id: "Approval" });
export type Approval = z.infer<typeof ApprovalSchema>;

export const PolicyEffectSchema = z.enum(["allow", "deny", "require_approval"]);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const PolicyRuleSchema = z.object({
  action: z.string().min(1),
  effect: PolicyEffectSchema,
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = entity(PolicyIdSchema, {
  projectId: ProjectIdSchema.nullable(),
  name: z.string().min(1),
  rules: z.array(PolicyRuleSchema),
}).meta({ id: "Policy" });
export type Policy = z.infer<typeof PolicySchema>;

export const BudgetSchema = entity(BudgetIdSchema, {
  missionId: MissionIdSchema.nullable(),
  crewId: CrewIdSchema.nullable(),
  limitTokens: z.number().int().min(0).nullable(),
  limitCost: z.number().min(0).nullable(),
  warnAtFraction: z.number().min(0).max(1),
}).meta({ id: "Budget" });
export type Budget = z.infer<typeof BudgetSchema>;

/** How a budget is enforced (core `BudgetPolicy`): hard blocks dispatch when exhausted, soft only warns. */
export const BudgetEnforceSchema = z.enum(["hard", "soft"]);
/** What to do when usage is unknown (an `unavailable` sample): allow or block dispatch. */
export const BudgetOnUnknownSchema = z.enum(["allow", "block"]);

/** A budget plus its enforcement settings, as carried by `mission.created` / `crew.created`. */
export const BudgetPolicySchema = BudgetSchema.extend({
  enforce: BudgetEnforceSchema.optional(),
  onUnknown: BudgetOnUnknownSchema.optional(),
}).meta({ id: "BudgetPolicy" });
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;

export const UsageSampleSchema = entity(UsageSampleIdSchema, {
  agentId: AgentIdSchema,
  tokens: z.number().int().min(0).nullable(),
  estimatedCost: z.number().min(0).nullable(),
  source: UsageSourceSchema,
}).meta({ id: "UsageSample" });
export type UsageSample = z.infer<typeof UsageSampleSchema>;

export const AuditEntrySchema = entity(AuditEntryIdSchema, {
  actor: z.string().min(1),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.string().min(1),
  details: z.unknown(),
}).meta({ id: "AuditEntry" });
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
